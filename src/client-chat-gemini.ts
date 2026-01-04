import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import dotenv from "dotenv";
import readline from "readline";
import { EventSource } from "eventsource";

// Polyfill global EventSource for Node.js
// @ts-ignore
global.EventSource = EventSource;

dotenv.config();

// Configuración
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:3032/sse";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

if (!GOOGLE_API_KEY) {
  console.error("❌ Error: GOOGLE_API_KEY no encontrada en .env");
  process.exit(1);
}

// Endpoint de Vertex AI (con soporte de API Key)
const GEMINI_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;

async function main() {
  console.log("🔌 Conectando al servidor MCP en:", MCP_SERVER_URL);

  // 1. Conectar Cliente MCP
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
  const client = new Client(
    { name: "chat-client-gemini", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Conectado al MCP!");
  } catch (error) {
    console.error("❌ Error conectando al MCP:", error);
    process.exit(1);
  }

  // 2. Obtener Herramientas y Convertir a Formato Gemini
  const toolsList = await client.listTools();
  const geminiTools = [
    {
      function_declarations: toolsList.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];

  console.log(`🛠️  Herramientas cargadas: ${toolsList.tools.map((t) => t.name).join(", ")}`);

  // 3. Interfaz de Chat
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n💬 Chat Iniciado con GEMINI (Escribe 'salir' para terminar)\n");

  // Historial de conversación
  let chatHistory: any[] = [];

  const chatLoop = () => {
    rl.question("Tú: ", async (input) => {
      if (input.toLowerCase() === "salir") {
        rl.close();
        process.exit(0);
      }

      try {
        // Agregar mensaje del usuario al historial
        chatHistory.push({
          role: "user",
          parts: [{ text: input }],
        });

        // Función para llamar a Gemini
        const callGemini = async (history: any[]) => {
          const payload = {
            contents: history,
            tools: geminiTools,
          };

          const response = await fetch(GEMINI_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            throw new Error(`Gemini API Error: ${response.status} ${response.statusText} - ${await response.text()}`);
          }

          return await response.json();
        };

        // Primera llamada
        let responseData = await callGemini(chatHistory);
        let candidate = responseData.candidates?.[0];
        let modelPart = candidate?.content?.parts?.[0];

        // Manejar llamadas a herramientas (Function Calling)
        while (modelPart?.functionCall) {
          console.log("🤖 Pensando (Ejecutando herramientas)...");
          
          const fnCall = modelPart.functionCall;
          const fnName = fnCall.name;
          const fnArgs = fnCall.args;

          console.log(`   > Ejecutando: ${fnName}`);

          // Ejecutar herramienta MCP
          let toolResult;
          try {
            const result = await client.callTool({
              name: fnName,
              arguments: fnArgs,
            });
            // @ts-ignore
            toolResult = result.content[0].text;
          } catch (err: any) {
            toolResult = `Error executing tool: ${err.message}`;
          }

          // Agregar la respuesta del modelo (Function Call) al historial
          chatHistory.push(candidate.content);

          // Agregar el resultado de la función al historial
          chatHistory.push({
            role: "function",
            parts: [{
              functionResponse: {
                name: fnName,
                response: { name: fnName, content: toolResult }
              }
            }]
          });

          // Llamar de nuevo a Gemini con el resultado
          responseData = await callGemini(chatHistory);
          candidate = responseData.candidates?.[0];
          modelPart = candidate?.content?.parts?.[0];
        }

        // Respuesta final de texto
        if (modelPart?.text) {
          console.log(`IA: ${modelPart.text}`);
          chatHistory.push(candidate.content);
        } else {
          console.log("IA: (Sin respuesta de texto)");
        }

      } catch (error) {
        console.error("❌ Error en el chat:", error);
      }

      chatLoop();
    });
  };

  chatLoop();
}

main();
