import dotenv from "dotenv";
dotenv.config();
import express from "express";
import centralRoute from "./src/routes/centralRoute.js";
import storyBookRoute from "./src/routes/storyBookRoute.js";
import sceneRoute from "./src/routes/sceneRoute.js";
import cors from "cors";
import { mongooseConnection } from "./src/config/mongooseConfig.js";

const app = express();
const corsOptions = {
  // origin: "https://storybookg.netlify.app", // Or use specific origin like "https://your-frontend.com"
  origin: "http://localhost:5173",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "ngrok-skip-browser-warning",
  ],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // This is critical for preflight
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res, next) => {
  return res.status(200).json({
    message: "Hello from root!",
  });
});

app.post("/user", (req, res, next) => {
  return res.status(200).json({
    message: "user created",
    name: req.body.name,
  });
});

app.use("/api/photo", centralRoute);
app.use("/api/storybook", storyBookRoute);
app.use("/api/scene", sceneRoute);

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

const PORT = process.env.PORT || 5000; // Render will set process.env.PORT

// Connect to DB *once* and then start the server
mongooseConnection()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on Port:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to connect to MongoDB. Server did not start.", error);
    process.exit(1);
  });
