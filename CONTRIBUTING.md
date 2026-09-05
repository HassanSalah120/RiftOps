# Contributing to RiftOps

Thank you for your interest in contributing to RiftOps! RiftOps is a free, open-source, local-first League of Legends operations deck designed for privacy, performance, and 100% Vanguard ban-safety.

---

## ??? Core Architecture & Ban-Safe Principles

Every line of code in RiftOps must strictly adhere to the following non-negotiable architectural rules:

1. **Zero Memory Access**: We never attach to `League of Legends.exe`, read process memory, or write to RAM.
2. **Zero DLL Injections & Hooks**: We never inject into the game, hook DirectX/Vulkan render pipelines, or modify official client files.
3. **Official Local APIs Only**: All interactions happen through supported Riot local HTTP and WebSocket endpoints (`127.0.0.1` LCU port) and Live Game Client Data API (`127.0.0.1:2999`).
4. **Zero Cloud Telemetry**: RiftOps runs strictly on the user''s machine. Account credentials are encrypted with native OS hardware mechanisms (**Windows DPAPI** / **macOS Keychain**). Never send telemetry or data to external servers.

---

## ??? Development Setup

### Prerequisites
- **Go**: 1.26 or newer
- **Node.js**: 22 or newer
- **npm**: 10 or newer
- **GCC / MinGW**: (Required for Windows desktop builds with CGo/WebView2)

### Building and Running Locally

1. **Clone the repository**:
   ```bash
   git clone https://github.com/HassanSalah120/RiftOps.git
   cd RiftOps
   ```

2. **Build Frontend**:
   ```bash
   cd cmd/riftops-ui/frontend
   npm install
   npm run build
   cd ../../..
   ```

3. **Run the Desktop App**:
   ```bash
   go run ./cmd/riftops-ui
   ```

### Running Tests

Before submitting a pull request, ensure all test suites pass:

- **Go Backend Tests**:
  ```bash
  go test ./...
  ```

- **Frontend Tests**:
  ```bash
  cd cmd/riftops-ui/frontend
  npm test
  ```

---

## ?? Pull Request Process

1. Fork the repository and create a descriptive branch:
   ```bash
   git checkout -b feature/my-cool-feature
   ```
2. Write clean, focused code following project conventions.
3. Add unit tests for any new business logic or LCU API parsing.
4. Ensure `go test ./...` and `npm test` pass.
5. Submit a pull request referencing any relevant issue.

Thank you for helping build a safer, better companion for the League community!
