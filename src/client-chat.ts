import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import readline from "readline";
import { EventSource } from "eventsource";

// Polyfill global EventSource for Node.js
// @ts-ignore
global.EventSource = EventSource;

dotenv.config();

// Configuración
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "http://localhost:3032/sse";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Error: OPENAI_API_KEY no encontrada en .env");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function main() {
  console.log("🔌 Conectando al servidor MCP en:", MCP_SERVER_URL);

  // 1. Conectar Cliente MCP
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
  const client = new Client(
    { name: "chat-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Conectado al MCP!");
  } catch (error) {
    console.error("❌ Error conectando al MCP:", error);
    process.exit(1);
  }

  // 2. Obtener Herramientas Disponibles
  const toolsList = await client.listTools();
  const tools = toolsList.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  console.log(`🛠️  Herramientas cargadas: ${tools.map((t) => t.function.name).join(", ")}`);

  // 3. Interfaz de Chat
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n💬 Chat Iniciado (Escribe 'salir' para terminar)\n");

  const chatLoop = () => {
    rl.question("Tú: ", async (input) => {
      if (input.toLowerCase() === "salir") {
        rl.close();
        process.exit(0);
      }

      try {
        const messages: any[] = [{ role: "user", content: input }];

        // Llamada inicial a OpenAI
        const response = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: messages,
          tools: tools,
          tool_choice: "auto",
        });

        const msg = response.choices[0].message;
        
        // Si el modelo quiere ejecutar herramientas
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log("🤖 Pensando (Ejecutando herramientas)...");
          messages.push(msg); // Guardar contexto

          for (const toolCall of msg.tool_calls) {
            // @ts-ignore
            const args = JSON.parse(toolCall.function.arguments);
            // @ts-ignore
            console.log(`   > Ejecutando: ${toolCall.function.name}`);

            // Ejecutar herramienta vía MCP
            const result = await client.callTool({
              // @ts-ignore
              name: toolCall.function.name,
              arguments: args,
            });

            // @ts-ignore
            const output = result.content[0].text;
            
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: output,
            });
          }

          // Segunda llamada a OpenAI con los resultados
          const finalResponse = await openai.chat.completions.create({
            model: "gpt-4-turbo-preview",
            messages: messages,
          });

          console.log(`IA: ${finalResponse.choices[0].message.content}`);
        } else {
          console.log(`IA: ${msg.content}`);
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
