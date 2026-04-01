import mongoose from "mongoose";

const imageOptionSchema = new mongoose.Schema(
  {
    option_idx: {
      type: Number,
      default: 0,
    },
    job_id: {
      type: String,
      default: null,
    },
    preview_url: {
      type: String,
      default: null,
    },
    raw_url: {
      type: String,
      default: null,
    },
    print_url: {
      type: String,
      default: null,
    },
    source_image_url: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

const aiKidImageSchema = new mongoose.Schema({
  req_id: { type: String, required: true },
  job_id: { type: String, required: true },
  job_ids: {
    type: [String],
    default: [],
  },
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

  image_options: {
    type: [imageOptionSchema],
    default: [],
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
