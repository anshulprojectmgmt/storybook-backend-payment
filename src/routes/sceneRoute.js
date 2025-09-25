import express from "express";
import { createScene } from "../controllers/sceneController.js";

const sceneRoute = express.Router();


sceneRoute.post("/", createScene);

export default sceneRoute;
