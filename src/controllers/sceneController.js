import SceneModel from "../models/sceneModel.js";

export const createScene = async (req, res) => {

    const { book_id, page_number, scene, prompt } = req.body;
    try {
        const newScene = new SceneModel({
            book_id,
            page_number,
            scene,
            prompt
        });
        await newScene.save();
        res.status(201).json({ message: "Scene created successfully", ok: true });
    } catch (error) {
        res.status(500).json({ message: "Error creating scene", ok: false });
    }

}