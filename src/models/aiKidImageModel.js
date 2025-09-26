import mongoose from "mongoose";

const aiKidImageSchema = new mongoose.Schema({}, { strict: false });

const AiKidImageModel = mongoose.model("AiKidImage", aiKidImageSchema);

export default AiKidImageModel;



