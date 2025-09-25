import mongoose from "mongoose";

const storyBookSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
    },
    description: {
        type: String,
        required: true,
    },
    cover_photo: {
        type: String,
        required: true,
    },
    page_count: {
        type: Number,
        required: true,
    },
    age_group: {
        type: String,
        required: true,
    },
    min_required_photos: {
        type: Number,
        required: true,
    },
    source: {
        type: String,
        required: true,
    },
    author: {
        type: String,
        required: true,
    },
    created_at: {
        type: Date,
        default: Date.now,
    },


});

const StoryBookModel = mongoose.model("StoryBook", storyBookSchema);
export default StoryBookModel;