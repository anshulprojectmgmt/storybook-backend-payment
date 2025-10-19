import express from "express";
import multer from "multer";

import {
  createBulkScenes,
  createScene,
} from "../controllers/sceneController.js";

const sceneRoute = express.Router();
// 1. Configure Multer to use memoryStorage
// This holds the file in a buffer instead of saving it to disk
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 2. Create the route
// 'images' is the field name we used in FormData on the frontend
// .array() accepts all files with this name
sceneRoute.post("/", createScene);
sceneRoute.post("/bulk-upload", upload.array("images"), createBulkScenes); //new code for bulkUpload

export default sceneRoute;
