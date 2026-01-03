import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "ollama";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";

async function main() {
  console.log("🧪 Probando conexión básica con Ollama...");
  console.log(`🔗 URL: ${OLLAMA_BASE_URL}`);
  console.log(`🤖 Modelo: ${OLLAMA_MODEL}`);

  const openai = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: OLLAMA_API_KEY,
  });

  try {
    const response = await openai.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: "Hola, ¿estás funcionando?" }],
    });

    console.log("\n✅ ¡Conexión exitosa!");
    console.log("💬 Respuesta de Ollama:", response.choices[0].message.content);
    console.log("\n⚠️ NOTA: Esta prueba básica funciona, pero para usar las herramientas de Base de Datos (MCP), NECESITAS actualizar Ollama a la versión 0.3.0+.");
  } catch (error: any) {
    console.error("\n❌ Error de conexión:", error.message);
    if (error.response) {
        console.error("Detalles:", error.response.data);
    }
  }
}

main();
