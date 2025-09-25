import express from "express";
import { storeOriginalImageToS3, add_photoToDB, getGeneratedImage, checkGenerationStatus, updatePageImage , createParentAndSendMail} from "../controllers/photoController.js";
import upload from "../middlewares/uploadMiddleware.js";

const centralRoute = express.Router();

centralRoute.post("/original_image",upload.single("image"), storeOriginalImageToS3);


centralRoute.post("/add_photo_to_queue", add_photoToDB);
centralRoute.post("/update_image", updatePageImage);
centralRoute.post("/send_preview", createParentAndSendMail);

centralRoute.get("/get_generation_details", getGeneratedImage )
centralRoute.get("/check_generation_status", checkGenerationStatus );


export default centralRoute;
