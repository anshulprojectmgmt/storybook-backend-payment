import express from "express";
import { createStoryBook, deleteStoryBook, getAllStoryBooks, updateStoryBook } from "../controllers/storyBookController.js";


const storyBookRoute = express.Router();

storyBookRoute.get("/",getAllStoryBooks);


storyBookRoute.post("/", createStoryBook);

storyBookRoute.put("/", updateStoryBook); 
storyBookRoute.delete("/", deleteStoryBook);

export default storyBookRoute;
