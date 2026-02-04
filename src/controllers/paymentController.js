import Razorpay from "razorpay";
import crypto from "crypto";
import ParentModel from "../models/parentModel.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * STEP 1: Create Razorpay Order
 * Called from frontend before opening checkout
 */
export const createOrder = async (req, res) => {
  try {
    const { req_id, amount } = req.body;

    if (!req_id || !amount) {
      return res.status(400).json({
        ok: false,
        error: "req_id and amount are required",
      });
    }

    // Ensure parent exists
    await ParentModel.findOneAndUpdate(
      { req_id },
      { $setOnInsert: { req_id, payment: "pending" } },
      { upsert: true, new: true },
    );

    const order = await razorpay.orders.create({
      amount: amount * 100, // Razorpay expects paise
      currency: "INR",
      receipt: req_id,
      payment_capture: 1,
    });

    return res.status(200).json({
      ok: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("❌ Create order failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to create Razorpay order",
    });
  }
};

/**
 * STEP 2: Verify Payment
 * Called after Razorpay success
 */
export const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      req_id,
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !req_id
    ) {
      return res.status(400).json({
        ok: false,
        error: "Missing payment verification fields",
      });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payment signature",
      });
    }

    // Mark payment as PAID
    await ParentModel.findOneAndUpdate(
      { req_id },
      {
        $set: {
          payment: "paid",
        },
      },
      { new: true },
    );

    return res.status(200).json({
      ok: true,
      message: "Payment verified successfully",
    });
  } catch (err) {
    console.error("❌ Payment verification failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Payment verification failed",
    });
  }
};

/**
 * STEP 3: Check Payment Status (Optional but useful)
 */
export const getPaymentStatus = async (req, res) => {
  try {
    const { req_id } = req.query;

    if (!req_id) {
      return res.status(400).json({ ok: false });
    }

    const parent = await ParentModel.findOne({ req_id }, { payment: 1 });

    return res.status(200).json({
      ok: true,
      paid: parent?.payment === "paid",
    });
  } catch (err) {
    return res.status(500).json({ ok: false });
  }
};
