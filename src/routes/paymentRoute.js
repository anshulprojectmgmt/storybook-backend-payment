import express from "express";
import {
  createOrder,
  verifyPayment,
  getPaymentStatus,
} from "../controllers/paymentController.js";

const paymentRoute = express.Router();

// Create Razorpay order
paymentRoute.post("/create-order", createOrder);

// Verify payment after success
paymentRoute.post("/verify", verifyPayment);

// Check payment status
paymentRoute.get("/status", getPaymentStatus);

export default paymentRoute;
