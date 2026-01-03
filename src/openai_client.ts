import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import { EventSource } from "eventsource";

// Cargar variables de entorno
dotenv.config();

// Polyfill para EventSource (necesario en Node.js para SSE)
global.EventSource = EventSource as any;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "ollama"; // Default placeholder if not needed
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

const MCP_SERVER_URL = "http://localhost:3032/sse";

async function main() {
  console.log("🚀 Iniciando Cliente OpenAI + MCP...");
  console.log(`🤖 Modelo Ollama: ${OLLAMA_MODEL}`);
  console.log(`🔗 URL Ollama: ${OLLAMA_BASE_URL}`);

  // 1. Conectar al Servidor MCP
  const transport = new SSEClientTransport(new URL(MCP_SERVER_URL));
  const mcpClient = new Client(
    { name: "openai-test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    console.log(`🔌 Conectando a ${MCP_SERVER_URL}...`);
    await mcpClient.connect(transport);
    console.log("✅ Conexión MCP establecida.");

    // 2. Obtener herramientas disponibles del servidor MCP
    // @ts-ignore
    const toolsList = await mcpClient.listTools();
    // @ts-ignore
    const mcpTools = toolsList.tools;
    console.log(
      `🛠️  Herramientas encontradas: ${mcpTools
        .map((t: any) => t.name)
        .join(", ")}`
    );

    // 3. Configurar Ollama (usando librería OpenAI compatible)
    const openai = new OpenAI({
      baseURL: OLLAMA_BASE_URL,
      apiKey: OLLAMA_API_KEY,
    });

    // Convertir herramientas MCP a formato OpenAI
    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = mcpTools.map(
      (tool: any) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })
    );

    // 4. Loop de conversación
    const userPrompt =
      "Dime cuentos pedidos detalles tenemos hoy en pedidosproduccion";

    console.log(`\n💬 Prompt Usuario: "${userPrompt}"\n`);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "Eres un asistente de análisis de datos. Tienes acceso a herramientas para consultar bases de datos y analizar pedidos. Úsalas para responder preguntas.",
      },
      { role: "user", content: userPrompt },
    ];

    // Paso 1: Llamada inicial a Ollama
    const response = await openai.chat.completions.create({
      model: "llama3", // Asegúrate de tener este modelo: `ollama pull llama3`
      messages: messages,
      tools: openaiTools,
      tool_choice: "auto",
    });

    const responseMessage = response.choices[0].message;
    messages.push(responseMessage);

    // Paso 2: Ejecutar herramientas si OpenAI lo pide
    if (responseMessage.tool_calls) {
      console.log("🤖 OpenAI quiere usar herramientas:");

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.type !== "function") continue;

        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`   👉 Ejecutando ${toolName} con args:`, toolArgs);

        // Llamar al servidor MCP
        // @ts-ignore
        const mcpResult = await mcpClient.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        // @ts-ignore
        const toolOutput = mcpResult.content[0].text;
        console.log(`   ✅ Resultado recibido (${toolOutput.length} chars).`);

        // Añadir resultado a la conversación
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput,
        });
      }

      // Paso 3: Llamada final a OpenAI con los resultados
      console.log("\n🔄 Enviando resultados a OpenAI para respuesta final...");
      const finalResponse = await openai.chat.completions.create({
        model: OLLAMA_MODEL,
        messages: messages,
      });

      console.log("\n✨ Respuesta Final del Agente:");
      console.log("-----------------------------------");
      console.log(finalResponse.choices[0].message.content);
      console.log("-----------------------------------");
    } else {
      console.log(
        "OpenAI respondió sin usar herramientas:",
        responseMessage.content
      );
    }
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    // await mcpClient.close(); // SSE transport no siempre cierra limpio en scripts cortos, ctrl+c para salir
    process.exit(0);
  }
}

main();
