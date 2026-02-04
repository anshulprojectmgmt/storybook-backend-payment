import mongoose from "mongoose";

const aiKidImageSchema = new mongoose.Schema({
  req_id: { type: String, required: true },
  job_id: { type: String, required: true },
  book_id: { type: mongoose.Schema.Types.ObjectId, ref: "StoryBookModel" },
  page_number: { type: Number, required: true },

  status: {
    type: String,
    enum: ["pending", "completed", "failed"],
    default: "pending",
  },

  // [caption, margin] URLs
  image_urls: {
    type: [String],
    default: null,
  },

  image_idx: {
    type: Number,
    default: 0,
  },

  // ✅ NEW FIELDS
  front_cover_url: {
    type: String,
    default: null,
  },

  back_cover_url: {
    type: String,
    default: null,
  },

  created_at: {
    type: Date,
    default: Date.now,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
});

const AiKidImageModel = mongoose.model("AiKidImage", aiKidImageSchema);
export default AiKidImageModel;
