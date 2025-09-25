import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

let isConnected = false;
export const mongooseConnection = async() => {
    if (isConnected) return;

    try {
    const db =  await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        isConnected = db.connections[0].readyState === 1;
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    throw error;
    }
}

