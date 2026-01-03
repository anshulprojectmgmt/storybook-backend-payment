import mongoose from "mongoose";

const parentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
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
});

const ParentMode = mongoose.model("Parent", parentSchema);
export default ParentMode;
