import mongoose from "mongoose";

const sceneSchema = new mongoose.Schema({
    book_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StoryBook",
        required: true,
    },
    page_number: {
        type: Number,
        required: true,
    },
    scene: {
        type: String,
        required: true,
    },
    prompt: {
        type: String,
        required: true,
    },
    sceneUrl: {   
    type: String,
    required: true,
  }
})


const SceneModel = mongoose.model("Scene", sceneSchema);
export default SceneModel;