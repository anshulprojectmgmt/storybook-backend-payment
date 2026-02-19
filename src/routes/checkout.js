import express from "express";
import { saveAddress } from "../controllers/saveAddress.js";

const checkoutRoutes = express.Router();

checkoutRoutes.post("/save-address", saveAddress);

export default checkoutRoutes;
