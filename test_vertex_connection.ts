import { VertexAI } from "@google-cloud/vertexai";
import * as dotenv from "dotenv";

dotenv.config();

async function listModels() {
  console.log("🔍 Checking Vertex AI Access...");
  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT}`);
  console.log(`Location: ${process.env.GOOGLE_CLOUD_LOCATION}`);
  console.log(`Key File: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);

  const vertexAI = new VertexAI({
    project: process.env.GOOGLE_CLOUD_PROJECT!,
    location: process.env.GOOGLE_CLOUD_LOCATION!
  });

  try {
    // There isn't a direct "listModels" in the generative-ai SDK easily accessible 
    // without using the underlying GAPIC client, but we can try a simple generation 
    // with a known safe model to test auth.
    
    console.log("Attempting to generate content with 'gemini-pro'...");
    const model = vertexAI.getGenerativeModel({ model: "gemini-pro" });
    const resp = await model.generateContent("Hello");
    console.log("✅ Success! Response:", resp.response.candidates?.[0].content.parts[0].text);
  } catch (error: any) {
    console.error("❌ Error testing gemini-1.0-pro:", error.message);
    
    if (error.message.includes("not found")) {
        console.log("\n⚠️  Possible causes:");
        console.log("1. Vertex AI API is not enabled for project 'sokso-mcp'.");
        console.log("2. The region 'us-central1' is incorrect.");
        console.log("3. The user credentials in key.json do not have 'Vertex AI User' permissions.");
    }
  }
}

listModels();
