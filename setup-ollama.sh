#!/bin/bash

echo "========================================="
echo " AI Research Assistant - Ollama Setup    "
echo "========================================="

# 1. Check if Ollama is installed
if ! command -v ollama &> /dev/null
then
    echo "[!] Ollama is not installed."
    echo "[*] Downloading and installing Ollama..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS installation
        curl -L https://ollama.com/download/Ollama-darwin.zip -o Ollama.zip
        unzip Ollama.zip
        echo "[*] Please move Ollama.app to your Applications folder and open it."
        echo "After starting Ollama, re-run this script."
        rm Ollama.zip
        exit 1
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux installation
        curl -fsSL https://ollama.com/install.sh | sh
    else
        echo "[x] Unsupported OS. Please install Ollama manually from https://ollama.com/download"
        exit 1
    fi
else
    echo "[✓] Ollama is installed."
fi

# 1.5 Configure CORS for Chrome Extensions
echo "[*] Configuring Ollama CORS (OLLAMA_ORIGINS=\"*\")..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    launchctl setenv OLLAMA_ORIGINS "*"
    # Restart Ollama if it's already running to pick up the new env var
    if pgrep -x "Ollama" > /dev/null; then
        echo "[*] Restarting Ollama to apply CORS settings..."
        killall Ollama
        sleep 2
        open -a Ollama
        sleep 5
    fi
fi

# 2. Check if Ollama server is running
echo "[*] Checking if Ollama server is running..."
if ! curl -s http://localhost:11434/api/version &> /dev/null
then
    echo "[!] Ollama server is not running on localhost:11434."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "[*] Setting OLLAMA_ORIGINS=\"*\" via launchctl for macOS app..."
        launchctl setenv OLLAMA_ORIGINS "*"
        echo "[*] Opening Ollama app..."
        open -a Ollama
        sleep 5
    else
        echo "[*] Starting Ollama in the background with OLLAMA_ORIGINS=\"*\"..."
        OLLAMA_ORIGINS="*" ollama serve &
        sleep 5
    fi
fi

if ! curl -s http://localhost:11434/api/version &> /dev/null
then
    echo "[x] Failed to start Ollama server. Please start it manually."
    exit 1
else
    echo "[✓] Ollama server is running."
fi

# 3. Pull required models
echo "[*] Pulling the default chat model (llama3.2)..."
ollama pull llama3.2

echo "[*] Pulling the embedding model for future Semantic RAG (nomic-embed-text)..."
ollama pull nomic-embed-text

echo "========================================="
echo "[✓] Setup Complete!"
echo "Ollama is running and the models are ready."
echo "You can now use the AI Research Assistant."
echo "========================================="
