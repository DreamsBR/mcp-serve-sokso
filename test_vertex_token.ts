import { VertexAI } from "@google-cloud/vertexai";
import { OAuth2Client } from "google-auth-library";
import * as dotenv from "dotenv";

dotenv.config();

async function listModels() {
  console.log("🔍 Checking Vertex AI Access...");
  
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION;
  // Limpiar token de espacios o saltos de línea si se pegó mal
  const token = process.env.VERTEX_ACCESS_TOKEN?.trim();

  console.log(`Project: ${project}`);
  console.log(`Location: ${location}`);

  let vertexAI;

  if (token) {
      console.log("🔑 Using provided VERTEX_ACCESS_TOKEN");
      // Create a client that uses the access token
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: token });
      
      vertexAI = new VertexAI({
          project: project!,
          location: location!,
          googleAuthOptions: {
              // @ts-ignore - authClient is valid in GoogleAuthOptions but types might mismatch slightly
              authClient: authClient
          }
      });
  } else {
      console.log("📂 Using GOOGLE_APPLICATION_CREDENTIALS (key.json)");
      console.log(`Key file path: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
      vertexAI = new VertexAI({
          project: project!,
          location: location!
      });
  }

  try {
    console.log("Attempting to generate content with 'gemini-1.5-flash-001'...");
    const model = vertexAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });
    const resp = await model.generateContent("Hello, are you there?");
    console.log("✅ Success! Response:", resp.response.candidates?.[0].content.parts[0].text);
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("404")) {
        console.log("\n💡 Tip: If using a token, ensure it has 'Vertex AI User' permissions.");
        console.log("If using key.json, ensure the API is enabled in Google Cloud Console.");
    }
  }
}

listModels();
