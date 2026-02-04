import express from "express";
import {
  createStoryBook,
  deleteStoryBook,
  getAllStoryBooks,
  getBookPrice,
  updateStoryBook,
} from "../controllers/storyBookController.js";

const storyBookRoute = express.Router();

storyBookRoute.get("/", getAllStoryBooks);
storyBookRoute.get("/price/:book_id", getBookPrice);

storyBookRoute.post("/", createStoryBook);

storyBookRoute.put("/", updateStoryBook);
storyBookRoute.delete("/", deleteStoryBook);

export default storyBookRoute;
