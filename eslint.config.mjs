import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // agent/ 已并入根包源码、与主仓共用工具链，无需排除。
    // .workbuddy/ 是 IDE 工作目录（记忆、备份、一次性验证脚本），不是产品代码。
    ".workbuddy/**",

  ]),
]);

export default eslintConfig;
