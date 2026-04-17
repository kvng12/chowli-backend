// server.js — Chowli Backend (Railway)
// Handles: Paystack webhooks, FCM push notifications, WhatsApp notifications, scheduled cleanup

const express    = require("express");
const crypto     = require("crypto");
const cors       = require("cors");
const cron       = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

// Lazy Twilio client — only initialised if env vars are present
function getTwilioClient() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return require("twilio")(sid, token);
}

// Format a UTC ISO timestamp into a human-readable local label, e.g. "Today at 1:00 PM"
function formatScheduledTime(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const tom = new Date(now); tom.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tom.toDateString();
  const dayLabel = isToday ? "Today" : isTomorrow ? "Tomorrow"
    : d.toLocaleDateString("en-NG", { weekday: "long", month: "short", day: "numeric" });
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const timeStr = `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  return `${dayLabel} at ${timeStr}`;
}

// Polyfill fetch for Node 18 compatibility
if (!globalThis.fetch) {
  globalThis.fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow requests from your Vercel frontend ──────────
app.use(cors({
  origin: [
    "https://mesa-bice.vercel.app",
    "http://localhost:5173",
    "http://localhost:4173",
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-chowli-secret"],
}));

// ── Supabase admin client (bypasses RLS) ─────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role — never expose to frontend
);

// ── Raw body for Paystack signature verification ─────────────
app.use("/webhooks/paystack", express.raw({ type: "application/json" }));
// Twilio sends form-encoded bodies; express.json() won't parse them.
// The /webhooks/twilio route uses its own express.urlencoded() inline.
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Chowli backend running" }));

// ── Debug: check if FCM token exists for a user ──────────────
app.get("/debug/token/:userId", async (req, res) => {
  if (req.headers["x-chowli-secret"] !== process.env.CHOWLI_INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, fcm_token")
    .eq("id", req.params.userId)
    .single();
  if (!data) return res.json({ found: false });
  res.json({
    found: true,
    name: data.full_name,
    hasToken: !!data.fcm_token,
    tokenPreview: data.fcm_token ? data.fcm_token.slice(0, 20) + "..." : null,
  });
});

// ── Debug: send a test notification to a user ────────────────
app.get("/debug/notify/:userId", async (req, res) => {
  if (req.headers["x-chowli-secret"] !== process.env.CHOWLI_INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("fcm_token, full_name")
    .eq("id", req.params.userId)
    .single();

  if (!profile?.fcm_token) {
    return res.json({ sent: false, reason: "No FCM token saved for this user" });
  }

  const result = await sendPushNotification({
    token: profile.fcm_token,
    title: "Test notification 🎉",
    body: "Chowli push notifications are working!",
    data: { type: "test" },
  });

  res.json({ sent: true, result });
});

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
    completed:  { title: "Order completed ✓", body: "Your order has been completed. Enjoy!" },
    delivered:  { title: "Order delivered! 🛵", body: "Your order has been delivered. Enjoy!" },
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

// ── Notify restaurant owner when a cash order is placed ──────
// Called by the frontend immediately after a cash order is saved to Supabase.
// (Online orders are notified via the Paystack charge.success webhook instead.)
app.post("/notify/new-order", async (req, res) => {
  console.log("[/notify/new-order] hit — body:", req.body);
  const { orderId, restaurantId } = req.body;
  if (!orderId || !restaurantId) {
    console.warn("[/notify/new-order] missing orderId or restaurantId");
    return res.status(400).json({ error: "Missing orderId or restaurantId" });
  }

  // Fetch order to check for scheduled_time
  const { data: order } = await supabase
    .from("orders")
    .select("scheduled_time")
    .eq("id", orderId)
    .single();

  console.log("[/notify/new-order] looking up restaurant:", restaurantId);
  const { data: restaurant, error: rErr } = await supabase
    .from("restaurants")
    .select("owner_id, name")
    .eq("id", restaurantId)
    .single();
  console.log("[/notify/new-order] restaurant result:", restaurant, rErr?.message);
  if (!restaurant) return res.json({ sent: false, reason: "Restaurant not found" });

  console.log("[/notify/new-order] looking up owner profile:", restaurant.owner_id);
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("fcm_token")
    .eq("id", restaurant.owner_id)
    .single();
  console.log("[/notify/new-order] profile result — hasToken:", !!profile?.fcm_token, pErr?.message);
  if (!profile?.fcm_token) return res.json({ sent: false, reason: "No FCM token for owner" });

  const scheduledLabel = order?.scheduled_time ? ` (Scheduled: ${formatScheduledTime(order.scheduled_time)})` : "";
  const fcmResult = await sendPushNotification({
    token: profile.fcm_token,
    title: "New order received! 💰",
    body:  `A customer placed a cash order at ${restaurant.name}${scheduledLabel}`,
    data:  { type: "new_order", order_id: String(orderId) },
  });
  console.log("[/notify/new-order] FCM result:", JSON.stringify(fcmResult));

  res.json({ sent: true });
});

// ── WhatsApp order notification (cash orders) ────────────────
// Called by the frontend after a cash order is saved to Supabase.
// Looks up owner phone from profiles and sends a WhatsApp message via Twilio.
app.post("/notify/whatsapp", async (req, res) => {
  const { orderId, restaurantId } = req.body;
  if (!orderId || !restaurantId) {
    return res.status(400).json({ error: "Missing orderId or restaurantId" });
  }

  // Fetch order details (subtotal, fulfillment, customer, scheduled_time)
  const { data: order } = await supabase
    .from("orders")
    .select("id, subtotal, fulfillment, customer_id, scheduled_time, order_items(name, quantity)")
    .eq("id", orderId)
    .single();

  if (!order) return res.json({ sent: false, reason: "Order not found" });

  // Get customer name
  const { data: customer } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", order.customer_id)
    .single();

  // Get restaurant owner
  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("owner_id, name")
    .eq("id", restaurantId)
    .single();

  if (!restaurant) return res.json({ sent: false, reason: "Restaurant not found" });

  // Get owner phone
  const { data: owner } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", restaurant.owner_id)
    .single();

  const rawPhone = owner?.phone;
  if (!rawPhone) {
    console.warn("[whatsapp] owner has no phone number — skipping");
    return res.json({ sent: false, reason: "Owner has no phone number" });
  }

  // Normalize to E.164 international format required by Twilio
  let ownerPhone;
  if (rawPhone.startsWith("+")) {
    ownerPhone = rawPhone;
  } else if (rawPhone.startsWith("234")) {
    ownerPhone = `+${rawPhone}`;
  } else if (rawPhone.startsWith("0")) {
    ownerPhone = `+234${rawPhone.slice(1)}`;
  } else {
    ownerPhone = `+234${rawPhone}`;
  }
  console.log(`[whatsapp] normalized phone: ${rawPhone} → ${ownerPhone}`);

  const client = getTwilioClient();
  if (!client) {
    console.warn("[whatsapp] Twilio not configured — skipping");
    return res.json({ sent: false, reason: "Twilio not configured" });
  }

  const customerName = customer?.full_name || "A customer";
  const itemsSummary = (order.order_items || [])
    .map(i => `${i.name} x${i.quantity}`)
    .join(", ") || "items";
  const total = Number(order.subtotal || 0).toLocaleString("en-NG");
  const fulfillmentLabel = order.fulfillment === "delivery" ? "Delivery" : "Pickup";
  const shortId = String(orderId).slice(0, 8).toUpperCase();

  const scheduledLine = order.scheduled_time
    ? `⏰ Scheduled for: ${formatScheduledTime(order.scheduled_time)}`
    : null;

  const body = [
    `🍽️ New Order on Chowli!`,
    ``,
    `Customer: ${customerName}`,
    `Items: ${itemsSummary}`,
    `Total: ₦${total}`,
    `Type: ${fulfillmentLabel}`,
    scheduledLine,
    `Order #${shortId}`,
    ``,
    `👆 Open Chowli now to confirm or cancel this order:`,
    `https://mesa-bice.vercel.app`,
  ].filter(Boolean).join("\n");

  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
      to:   `whatsapp:${ownerPhone}`,
      body,
    });
    console.log(`[whatsapp] sent to ${ownerPhone} for order ${shortId}`);
    res.json({ sent: true });
  } catch (err) {
    console.error("[whatsapp] send failed:", err.message);
    res.json({ sent: false, reason: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  WHATSAPP CUSTOMER ORDER CONFIRMATION (fraud check)
// ════════════════════════════════════════════════════════════

// In-memory map: normalizedPhone → { orderId, timer }
// Persists only for the lifetime of this process; cron job at 15 min catches restarts.
const pendingConfirmations = new Map();

function normalizePhone(raw) {
  if (!raw) return null;
  if (raw.startsWith("+"))   return raw;
  if (raw.startsWith("234")) return `+${raw}`;
  if (raw.startsWith("0"))   return `+234${raw.slice(1)}`;
  return `+234${raw}`;
}

async function cancelOrder(orderId, reason) {
  const { error } = await supabase
    .from("orders")
    .update({ status: "cancelled" })
    .eq("id", orderId)
    .eq("status", "pending"); // only cancel if still pending
  if (!error) console.log(`[whatsapp-confirm] auto-cancelled order ${orderId}: ${reason}`);
}

// Called by frontend after a cash order is placed.
// Sends customer WhatsApp asking YES/NO and sets a 10-min auto-cancel timer.
app.post("/notify/whatsapp-customer", async (req, res) => {
  const { orderId, customerId } = req.body;
  if (!orderId || !customerId) return res.status(400).json({ error: "Missing orderId or customerId" });

  const { data: order } = await supabase
    .from("orders")
    .select("id, subtotal, restaurant_id")
    .eq("id", orderId)
    .single();
  if (!order) return res.json({ sent: false, reason: "Order not found" });

  const { data: customer } = await supabase
    .from("profiles")
    .select("full_name, phone")
    .eq("id", customerId)
    .single();

  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("name")
    .eq("id", order.restaurant_id)
    .single();

  const rawPhone = customer?.phone;
  if (!rawPhone) {
    console.warn(`[whatsapp-confirm] customer ${customerId} has no phone — skipping`);
    return res.json({ sent: false, reason: "Customer has no phone number" });
  }

  const customerPhone = normalizePhone(rawPhone);
  const client        = getTwilioClient();
  if (!client) {
    console.warn("[whatsapp-confirm] Twilio not configured — skipping");
    return res.json({ sent: false, reason: "Twilio not configured" });
  }

  const name   = customer?.full_name || "there";
  const amount = Number(order.subtotal || 0).toLocaleString("en-NG");
  const rname  = restaurant?.name || "the restaurant";
  const body   = [
    `Hi ${name}! 👋`,
    ``,
    `You just placed a cash order of ₦${amount} from ${rname} on Chowli.`,
    ``,
    `Reply *YES* to confirm or *NO* to cancel.`,
    `No reply in 10 minutes = auto-cancel.`,
  ].join("\n");

  try {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
      to:   `whatsapp:${customerPhone}`,
      body,
    });
    console.log(`[whatsapp-confirm] sent to ${customerPhone} for order ${orderId}`);

    // Clear any previous timer for this phone
    const existing = pendingConfirmations.get(customerPhone);
    if (existing?.timer) clearTimeout(existing.timer);

    // 10-minute auto-cancel timer
    const timer = setTimeout(() => {
      console.log(`[whatsapp-confirm] no reply from ${customerPhone} — cancelling order ${orderId}`);
      cancelOrder(orderId, "no WhatsApp reply in 10 minutes");
      pendingConfirmations.delete(customerPhone);
    }, 10 * 60 * 1000);

    pendingConfirmations.set(customerPhone, { orderId, timer });
    res.json({ sent: true });
  } catch (err) {
    console.error("[whatsapp-confirm] send failed:", err.message);
    res.json({ sent: false, reason: err.message });
  }
});

// ── Twilio incoming message webhook ─────────────────────────
// Configure this URL in Twilio console: Messaging > WhatsApp Sandbox > "When a message comes in"
// URL: https://your-railway-app.up.railway.app/webhooks/twilio
app.post("/webhooks/twilio", express.urlencoded({ extended: false }), async (req, res) => {
  const from = req.body?.From || "";  // e.g. "whatsapp:+2348012345678"
  const body = (req.body?.Body || "").trim().toUpperCase();

  console.log(`[twilio-webhook] from=${from} body="${body}"`);

  // Normalise: strip "whatsapp:" prefix
  const phone = from.replace(/^whatsapp:/, "");
  const entry = pendingConfirmations.get(phone);

  if (!entry) {
    console.log(`[twilio-webhook] no pending confirmation for ${phone}`);
    return res.status(200).send("<Response></Response>");
  }

  clearTimeout(entry.timer);
  pendingConfirmations.delete(phone);

  if (body === "YES" || body.startsWith("YES")) {
    console.log(`[twilio-webhook] ${phone} confirmed order ${entry.orderId}`);
    // No action needed — order remains pending, restaurant confirms it
  } else if (body === "NO" || body.startsWith("NO")) {
    console.log(`[twilio-webhook] ${phone} cancelled order ${entry.orderId}`);
    await cancelOrder(entry.orderId, "customer replied NO on WhatsApp");
  } else {
    console.log(`[twilio-webhook] unrecognised reply "${body}" from ${phone} — treating as no-action`);
  }

  // TwiML empty response
  res.status(200).type("text/xml").send("<Response></Response>");
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
//  CRON JOBS
// ════════════════════════════════════════════════════════════

// Auto-cancel orders that have been 'pending' for more than 15 minutes.
// Runs every 5 minutes.
cron.schedule("*/5 * * * *", async () => {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  console.log(`[cron/auto-cancel] checking for stale pending orders (older than ${cutoff})`);

  const { data: stale, error } = await supabase
    .from("orders")
    .select("id, customer_id")
    .eq("status", "pending")
    .lt("created_at", cutoff);

  if (error) { console.error("[cron/auto-cancel] query error:", error.message); return; }
  if (!stale?.length) { console.log("[cron/auto-cancel] no stale orders found"); return; }

  console.log(`[cron/auto-cancel] cancelling ${stale.length} order(s)`);

  for (const order of stale) {
    // Update status to cancelled
    const { error: updateErr } = await supabase
      .from("orders")
      .update({ status: "cancelled" })
      .eq("id", order.id);

    if (updateErr) {
      console.error(`[cron/auto-cancel] failed to cancel order ${order.id}:`, updateErr.message);
      continue;
    }

    // Push notification to customer
    const { data: profile } = await supabase
      .from("profiles")
      .select("fcm_token")
      .eq("id", order.customer_id)
      .single();

    if (profile?.fcm_token) {
      await sendPushNotification({
        token: profile.fcm_token,
        title: "Order cancelled ⏱️",
        body:  "Your order was cancelled because the restaurant didn't respond in time.",
        data:  { type: "order_status", order_id: String(order.id), status: "cancelled" },
      });
    }

    console.log(`[cron/auto-cancel] cancelled order ${order.id}`);
  }
});

// Auto-release delivered orders after the 2-hour confirmation window.
// Runs every 5 minutes. Calls the auto_release_orders() Postgres function
// which sets confirmed_at + status='completed' for eligible orders,
// then sends a push notification to each affected customer.
cron.schedule("*/5 * * * *", async () => {
  console.log("[cron/auto-release] checking for expired delivery confirmation windows");

  // Call the DB function — returns rows of released_order_id
  const { data: released, error } = await supabase.rpc("auto_release_orders");

  if (error) {
    console.error("[cron/auto-release] RPC error:", error.message);
    return;
  }

  if (!released?.length) {
    console.log("[cron/auto-release] no orders to release");
    return;
  }

  console.log(`[cron/auto-release] released ${released.length} order(s)`);

  // Send push notification to each customer
  for (const row of released) {
    const orderId = row.released_order_id;
    try {
      const { data: order } = await supabase
        .from("orders")
        .select("customer_id, profiles(fcm_token, full_name)")
        .eq("id", orderId)
        .single();

      const fcmToken = order?.profiles?.fcm_token;
      if (fcmToken) {
        await sendPushNotification({
          token: fcmToken,
          title: "Order auto-confirmed ✓",
          body:  "Your delivery was auto-confirmed after 2 hours. Payment released to the restaurant.",
          data:  { type: "order_status", order_id: String(orderId), status: "completed" },
        });
        console.log(`[cron/auto-release] notified customer for order ${orderId}`);
      }
    } catch (notifyErr) {
      console.error(`[cron/auto-release] notification failed for ${orderId}:`, notifyErr.message);
    }
  }
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`Chowli backend running on port ${PORT}`));