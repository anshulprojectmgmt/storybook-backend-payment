import mongoose from "mongoose";

export const mongooseConnection = async () => {
  // Check if we're already connected or connecting
  if (mongoose.connection.readyState === 1) {
    console.log("MongoDB is already connected.");
    return;
  }

  try {
    // Pass no options, Mongoose 6+ uses good defaults
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    // This throw is important! It will stop the server from starting
    // if the database can't be reached.
    throw error;
  }
};
