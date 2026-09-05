// Simulate agent cognitive step on openai.com homepage
async function testOpenAICognitiveStep() {
  const goal = "open open ai website and login with my first email and hit the download button for desktop";
  const pageUrl = "https://openai.com";
  const pageTitle = "OpenAI: Research & Deployment";
  
  // Real elements from openai.com homepage
  const elements = [
    { tag_id: 1, role: "link", text: "OpenAI", aria_label: "OpenAI Homepage" },
    { tag_id: 2, role: "link", text: "Research" },
    { tag_id: 3, role: "link", text: "Products" },
    { tag_id: 4, role: "link", text: "Developers" },
    { tag_id: 5, role: "button", text: "Log in", aria_label: "Log in" },
    { tag_id: 6, role: "button", text: "Try ChatGPT", aria_label: "Try ChatGPT" },
    { tag_id: 7, role: "textarea", placeholder: "What can I help with?", aria_label: "Prompt input" },
    { tag_id: 8, role: "button", aria_label: "Send prompt" },
    { tag_id: 9, role: "button", text: "Accept all", aria_label: "Accept cookies" }
  ];

  const elementLines = elements.map(el => {
    return `[${el.tag_id}] ${el.role} "${el.text || el.aria_label || el.placeholder}"`;
  }).join('\n');

  const prompt = `<|im_start|>system
You are an autonomous browser agent. Your job is to complete the user's goal by deciding the SINGLE NEXT action based on the live page state and interactive elements.

Output JSON only in this exact format:
{
  "action": "click|type|press_key|navigate|scroll|done",
  "tag_id": <int or null>,
  "value": "<text to type or URL to navigate, or null>",
  "intent": "<short human readable description of this action>",
  "reasoning": "<explain why this specific action is the correct next step towards the goal>",
  "is_done": false
}

Rules:
1. ONLY decide the ONE immediate next action needed for the current screen. Do not invent future steps.
2. Only use tag_id from the ELEMENTS list.
3. If cookie banners or popups are present, dismiss them or proceed to the relevant button (e.g. "Log in").
4. If goal requires login and you are on the homepage, click "Log in" or "Sign in".
5. Output valid JSON only.
<|im_end|>
<|im_start|>user
GOAL: ${goal}
CURRENT PAGE: ${pageUrl} (${pageTitle})
ELEMENTS ON CURRENT SCREEN:
${elementLines}

ACTION HISTORY SO FAR:
None (just opened page)

Decide the single next action.
<|im_end|>
<|im_start|>assistant
`;

  console.log("Calling Qwen2.5:3b with live screen context...");
  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:3b",
      prompt,
      format: "json",
      stream: false,
      options: { temperature: 0.1, top_p: 0.9 },
      keep_alive: "60m"
    })
  });

  const data = await res.json();
  const t1 = Date.now();
  console.log(`Latency: ${t1 - t0}ms`);
  console.log("Response:", data.response);
}

testOpenAICognitiveStep();
