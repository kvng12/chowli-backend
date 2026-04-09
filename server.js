// server.js — Chowli Backend (Railway)
// Handles: Paystack webhooks, FCM push notifications, scheduled cleanup

const express    = require("express");
const crypto     = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase admin client (bypasses RLS) ─────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role — never expose to frontend
);

// ── Raw body for Paystack signature verification ─────────────
app.use("/webhooks/paystack", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Chowli backend running" }));

// ════════════════════════════════════════════════════════════
//  PAYSTACK WEBHOOK
// ════════════════════════════════════════════════════════════
app.post("/webhooks/paystack", async (req, res) => {
  // 1. Verify signature
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    console.warn("Invalid Paystack signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(req.body);
  console.log("Paystack event:", event.event);

  // 2. Handle successful charge
  if (event.event === "charge.success") {
    const ref      = event.data.reference;
    const amount   = event.data.amount / 100; // Paystack sends kobo
    const email    = event.data.customer?.email;

    // Find order by Paystack reference
    const { data: order, error } = await supabase
      .from("orders")
      .select("id, customer_id, restaurant_id, subtotal")
      .eq("paystack_reference", ref)
      .single();

    if (error || !order) {
      console.error("Order not found for ref:", ref);
      return res.status(200).json({ received: true }); // always 200 to Paystack
    }

    // Update payment status
    await supabase
      .from("orders")
      .update({ payment_status: "paid", status: "confirmed" })
      .eq("id", order.id);

    console.log(`✓ Payment verified for order ${order.id} — ₦${amount}`);

    // Send push notification to restaurant owner
    await notifyOrderPaid(order);
  }

  res.status(200).json({ received: true });
});

// ════════════════════════════════════════════════════════════
//  FCM PUSH NOTIFICATIONS
// ════════════════════════════════════════════════════════════
const FCM_ENDPOINT = "https://fcm.googleapis.com/v1/projects/" + process.env.FCM_PROJECT_ID + "/messages:send";

async function getFCMAccessToken() {
  // Use service account credentials to get OAuth2 token
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();
  return token.token;
}

async function sendPushNotification({ token, title, body, data = {} }) {
  try {
    const accessToken = await getFCMAccessToken();
    const response = await fetch(FCM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          android: { priority: "high" },
          apns: { payload: { aps: { sound: "default", badge: 1 } } },
        },
      }),
    });
    const result = await response.json();
    if (!response.ok) console.error("FCM error:", result);
    return result;
  } catch (err) {
    console.error("Push notification failed:", err.message);
  }
}

// ── Notify restaurant when order is placed ───────────────────
async function notifyOrderPaid(order) {
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("owner_id, name")
    .eq("id", order.restaurant_id)
    .single();
  if (!restaurant) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("fcm_token")
    .eq("id", restaurant.owner_id)
    .single();
  if (!profile?.fcm_token) return;

  await sendPushNotification({
    token: profile.fcm_token,
    title: "New paid order! 🎉",
    body: `A customer just paid for their order at ${restaurant.name}`,
    data: { type: "new_order", order_id: order.id },
  });
}

// ── Notify customer when order status changes ─────────────────
app.post("/notify/order-status", async (req, res) => {
  const { orderId, status, customerId } = req.body;

  // Only allow calls from Supabase (verify a shared secret)
  if (req.headers["x-chowli-secret"] !== process.env.CHOWLI_INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("fcm_token, full_name")
    .eq("id", customerId)
    .single();

  if (!profile?.fcm_token) return res.json({ sent: false, reason: "No token" });

  const STATUS_MESSAGES = {
    confirmed:  { title: "Order confirmed! ✅", body: "Your order has been confirmed. Sit tight!" },
    preparing:  { title: "Order being prepared 👨‍🍳", body: "The kitchen is working on your order." },
    ready:      { title: "Order ready! 🎉", body: "Your order is ready for pickup/delivery!" },
    cancelled:  { title: "Order cancelled", body: "Your order was cancelled. Contact the restaurant for details." },
  };

  const msg = STATUS_MESSAGES[status];
  if (!msg) return res.json({ sent: false, reason: "Unknown status" });

  await sendPushNotification({
    token: profile.fcm_token,
    title: msg.title,
    body: msg.body,
    data: { type: "order_status", order_id: orderId, status },
  });

  res.json({ sent: true });
});

// ── Save FCM token for a user ────────────────────────────────
app.post("/fcm/save-token", async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).json({ error: "Missing userId or token" });

  await supabase
    .from("profiles")
    .update({ fcm_token: token })
    .eq("id", userId);

  res.json({ saved: true });
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`Chowli backend running on port ${PORT}`));
