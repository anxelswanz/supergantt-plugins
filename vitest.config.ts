import { configDefaults, defineConfig } from "vitest/config";

// 环境按文件顶部的 `// @vitest-environment jsdom` 注解切换：
// 纯逻辑测试跑在 node 下，只有 DOM 测试才付出启动 jsdom 的代价
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
