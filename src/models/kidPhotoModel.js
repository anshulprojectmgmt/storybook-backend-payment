import mongoose from 'mongoose';

const kidPhotoSchema = new mongoose.Schema({
    file_name: {
        type: String,
        required: true,
    },
    file_url: {
        type: String,
        required: true,
    },
    request_id: {
        type: String,
        required: true,
    },
    dateTaken: {
        type: Date,
        default: Date.now,
    },
});

const KidPhotoModel = mongoose.model('KidPhoto', kidPhotoSchema);
export default KidPhotoModel;