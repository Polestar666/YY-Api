# 🍒 YY API Hub —— 基于 Cherry Studio 风格的 API 汇总与中转平台

## 📖 项目简介

**YY  API Hub** 是一款受 **YY  Studio** 界面美学与交互逻辑启发而设计的 **API 汇总与中转网站**。  
它并非简单的 API 代理，而是一个集 **API 发现、聚合管理、统一中转、用量统计** 于一体的开发者工具平台。

> 🎯 目标用户：AI 应用开发者、多模型调用团队、需要统一 API 入口的企业级项目。

---

## ✨ 核心功能

### 1. 🧩 多源 API 汇总
- 支持 **OpenAI、Anthropic、Google Gemini、Cohere、国内主流模型（智谱/通义/文心/DeepSeek 等）** 的 API 接入。
- 提供公开与私有 API 资源市场，可分享或订阅他人上传的可用 API 端点。

### 2. 🔄 智能中转服务
- 统一请求格式转换，屏蔽不同厂商的 API 差异。
- 自动负载均衡与故障转移：当某个 API Key 或端点失效时，自动切换备用资源。
- 支持流式响应（SSE）与普通 HTTP 请求。

### 3. 📊 可视化控制台（Cherry Studio 风格）
- 深色/浅色双主题，卡片式布局，侧边栏管理。
- 实时请求监控、用量统计、日志查询。
- 类似对话界面的 API 测试工具，可直接调试不同模型。

### 4. 🔐 安全与权限控制
- API Key 与用户角色分离，支持多租户模式。
- 可设置调用频率、额度限制、白名单 IP。
- 请求数据默认脱敏，可选加密存储。

### 5. 💰 计费与结算（可选）
- 按量计费、包月套餐或免费额度模式。
- 支持 OpenAPI 格式生成账单记录。

---
# 🔄 API Gateway Hub —— 通用 API 汇总与智能转发平台

## 📌 项目概述

**API Gateway Hub** 是一个专注于 **API 资源汇总** 与 **统一转发** 的中枢平台。它解决了开发者在使用多种第三方 API 时的核心痛点：**密钥分散、接口差异、用量统计困难、故障切换麻烦**。

> 💡 一句话定位：**把所有 API 都汇聚到一个入口，用一个密钥、一套协议、一个后台管理全部调用。**

---

## 🎯 解决什么问题

| 痛点 | 解决方案 |
|------|----------|
| 10 个 API 需要申请 10 个 Key，管理混乱 | 只生成 **1 个平台 Key**，所有 API 统一认证 |
| 每个厂商的请求格式、鉴权方式不同 | 平台做 **协议转换**，对外统一为 REST 风格 |
| 某个 API 突然限流或失效，业务中断 | **自动故障转移** + 多备用端点轮询 |
| 不知道每个 API 用了多少次、花了多少钱 | **全量日志** + 用量图表 + 预算告警 |
| 想换供应商需要改全部代码 | 只改平台配置，**业务代码零改动** |

---

## 🖥 界面预览（示意图）

<img width="1464" height="749" alt="image" src="https://github.com/user-attachments/assets/50212e01-f9d9-43c0-a92b-513da11dc671" />
<img width="1895" height="959" alt="image" src="https://github.com/user-attachments/assets/9a5bdb64-4695-44e3-b0b8-5f76a0b96c1e" />
<img width="1814" height="983" alt="image" src="https://github.com/user-attachments/assets/c9bc5880-98a7-4746-abf8-dc0123ae49f5" />
<img width="1856" height="965" alt="image" src="https://github.com/user-attachments/assets/3bc319ac-fc3d-4986-901a-89f23737a1c7" />
<img width="1721" height="975" alt="image" src="https://github.com/user-attachments/assets/daeeacc0-3bc9-4ee1-9679-cfa5c64c538a" />
<img width="1524" height="956" alt="image" src="https://github.com/user-attachments/assets/89da5294-3824-4622-b117-71c1b24a5c4f" />
<img width="1109" height="776" alt="image" src="https://github.com/user-attachments/assets/b163e16b-dbd0-49c4-99bd-1844d7ce4bb6" />
<img width="1110" height="776" alt="image" src="https://github.com/user-attachments/assets/c3346969-83bf-49bd-a788-2c42990fdf3c" />
