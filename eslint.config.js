import js from "@eslint/js";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        document: "readonly",
        window: "readonly",
        Worker: "readonly",
        Blob: "readonly",
        URL: "readonly",
        FileReader: "readonly",
        File: "readonly",
        Uint8Array: "readonly",
        ArrayBuffer: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        self: "readonly",
        postMessage: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off"
    }
  }
];
