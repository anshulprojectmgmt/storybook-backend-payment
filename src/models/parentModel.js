import mongoose from "mongoose";

const addressSchema = new mongoose.Schema({
  line1: String,
  line2: String,
  city: String,
  state: String,
  pincode: String,
  country: String,
});

const parentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  kidName: {
    type: String,
    required: true,
  },
  phone: String,
  address: addressSchema,
  email: {
    type: String,
    required: true,
  },
  kidName: {
    type: String,
    required: true,
  },
  req_id: {
    type: String,
    required: true,
    unique: true,
  },
  payment: {
    type: String,
    enum: ["paid", "pending"],
    default: "pending",
  },
  pdf_url: {
    type: String,
    default: null,
  },
  notify: {
    type: Boolean,
    default: false, // Default to false to send email notifications
  },
  preview_email_sent: { type: Boolean, default: false },
  pdf_email_sent: { type: Boolean, default: false },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // timestamps: true,
});

const parentModel = mongoose.model("Parent", parentSchema);
export default parentModel;
