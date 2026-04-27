import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
  try {
    const chat = ai.chats.create({
      model: 'gemini-3-pro-preview',
      config: {
        systemInstruction: "You are a bot.",
        tools: [{
          functionDeclarations: [{
            name: "test_tool",
            description: "A test tool",
            parameters: {
              type: "OBJECT",
              properties: {
                arg1: { type: "STRING" }
              }
            }
          }]
        }]
      }
    });
    const result = await chat.sendMessage({ message: "Call the test tool with arg1='hello'. You MUST call the tool." });
    if (!result.functionCalls) {
      console.log("No function calls returned:", result.text);
      return;
    }
    const functionCall = result.functionCalls[0];
    const functionResponseData = { status: "ok" };
    
    // Sending response WITHOUT ID
    const res2 = await chat.sendMessage({
      message: [{
        functionResponse: {
          name: functionCall.name,
          response: functionResponseData
        }
      }]
    });
    console.log("Success 2 without ID:", res2.text);

    // Sending response WITH ID
    const chat3 = ai.chats.create({
      model: 'gemini-3-pro-preview',
      config: {
        tools: [{
          functionDeclarations: [{
            name: "test_tool",
            description: "A test tool",
            parameters: { type: "OBJECT", properties: { arg1: { type: "STRING" } } }
          }]
        }]
      }
    });
    const result3 = await chat3.sendMessage({ message: "Call the test tool with arg1='hello'. You MUST call the tool." });
    const functionCall3 = result3.functionCalls[0];
    const res4 = await chat3.sendMessage({
      message: [{
        functionResponse: {
          id: functionCall3.id,
          name: functionCall3.name,
          response: { status: "ok" }
        }
      }]
    });
    console.log("Success 4 with ID:", res4.text);
  } catch (err) {
    console.error("Error:", err.message);
  }
}
test();
