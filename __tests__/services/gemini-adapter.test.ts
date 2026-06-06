import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGenerateContent, mockCtor } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockCtor: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };

    constructor(options: unknown) {
      mockCtor(options);
    }
  },
}));

import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  GoogleGenerativeAIAdapter,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResult,
  type Part,
} from '../../src/services/gemini-adapter';

describe('GoogleGenerativeAIAdapter', () => {
  beforeEach(() => {
    mockCtor.mockClear();
    mockGenerateContent.mockReset();
  });

  it('maps basic completion calls to @google/genai models.generateContent', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'hello',
      functionCalls: undefined,
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    });

    const client = new GoogleGenerativeAIAdapter('test-key');
    const model = client.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: 'Be concise.',
      generationConfig: { maxOutputTokens: 128, temperature: 0.2 },
    });

    const result = await model.generateContent([{ text: 'Say hello' }]);

    expect(mockCtor).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: [{ text: 'Say hello' }],
      config: {
        systemInstruction: 'Be concise.',
        maxOutputTokens: 128,
        temperature: 0.2,
      },
    });
    expect(result.response.text()).toBe('hello');
    expect(result.response.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 });
  });

  it('preserves JSON mode generation config', async () => {
    mockGenerateContent.mockResolvedValue({ text: '{"ok":true}', functionCalls: undefined });

    const client = new GoogleGenerativeAIAdapter('test-key');
    const model = client.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
      },
    });

    const result = await model.generateContent('Return JSON');

    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: 'Return JSON',
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
      },
    });
    expect(result.response.text()).toBe('{"ok":true}');
  });

  it('preserves tool declarations and tool config', async () => {
    const functionCalls = [{ name: 'set_reminder', args: { message: 'stretch' } }];
    mockGenerateContent.mockResolvedValue({ text: undefined, functionCalls });

    const tools = [{ functionDeclarations: [{ name: 'set_reminder', parameters: { type: 'OBJECT' } }] }];
    const toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    const client = new GoogleGenerativeAIAdapter('test-key');
    const model = client.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools,
      toolConfig,
    });

    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: 'remind me' }] }] });

    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'remind me' }] }],
      config: { tools, toolConfig },
    });
    expect(result.response.functionCalls()).toEqual(functionCalls);
  });

  it('exports old SDK-compatible enum values and request types', () => {
    const parts: Part[] = [
      { text: 'hello' },
      { inlineData: { mimeType: 'image/png', data: 'abc123' } },
      { functionCall: { name: 'set_reminder', args: { message: 'stretch' } } },
      { functionResponse: { name: 'set_reminder', response: { ok: true } } },
    ];
    const contents: Content[] = [{ role: 'user', parts }];
    const declaration: FunctionDeclaration = {
      name: 'set_reminder',
      description: 'Create a reminder',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          message: { type: SchemaType.STRING },
          priority: { type: SchemaType.INTEGER },
        },
        required: ['message'],
      },
    };

    expect(contents[0].parts).toHaveLength(4);
    expect(declaration.parameters?.type).toBe('object');
    expect(FunctionCallingMode.AUTO).toBe('AUTO');
    expect(SchemaType.STRING).toBe('string');
  });

  it('preserves old SDK response helpers, candidates, and usage metadata', async () => {
    const functionCalls = [
      { name: 'set_reminder', args: { message: 'stretch' } },
      { name: 'archive_task', args: { id: 42 } },
    ];
    mockGenerateContent.mockResolvedValue({
      text: 'done',
      functionCalls,
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
    });

    const model = new GoogleGenerativeAI('test-key').getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result: GenerateContentResult = await model.generateContent('finish this');

    expect(result.response.text()).toBe('done');
    expect(result.response.functionCall()).toEqual(functionCalls[0]);
    expect(result.response.functionCalls()).toEqual(functionCalls);
    expect(result.response.candidates?.[0]?.finishReason).toBe('STOP');
    expect(result.response.usageMetadata?.promptTokenCount).toBe(8);
  });
});
