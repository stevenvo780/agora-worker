FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Update and install dependencies
# Development essentials + language support + utilities
RUN apt-get update && apt-get install -y \
    # Basic tools
    sudo \
    curl \
    git \
    wget \
    nano \
    vim \
    htop \
    tree \
    less \
    unzip \
    zip \
    jq \
    # Network tools
    net-tools \
    iputils-ping \
    dnsutils \
    openssh-client \
    # Build essentials
    ca-certificates \
    gnupg \
    build-essential \
    make \
    cmake \
    gcc \
    g++ \
    # Version control
    git-lfs \
    # Text processing
    ripgrep \
    fd-find \
    fzf \
    bat \
    # File management
    rsync \
    # Locales for proper encoding
    locales \
    && rm -rf /var/lib/apt/lists/*

# Generate locale
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Install Node.js 20.x (LTS)
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install global npm packages
RUN npm install -g \
    pnpm \
    yarn \
    typescript \
    ts-node \
    nodemon \
    live-server \
    http-server

# Create symlinks for better command names
RUN ln -sf /usr/bin/fdfind /usr/bin/fd && \
    ln -sf /usr/bin/batcat /usr/bin/bat 2>/dev/null || true

# Create estudiante user with sudo privileges (passwordless)
RUN useradd -m -s /bin/bash estudiante && \
    echo "estudiante ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    usermod -aG sudo estudiante

WORKDIR /app

# Install Node requirements
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY index.js .
COPY sync_agent.js .
COPY entrypoint.sh .

# Make entrypoint executable
RUN chmod +x entrypoint.sh

# Environment defaults
ENV NEXUS_URL=http://localhost:3010
# WORKER_TOKEN must be provided at runtime (e.g., personal:<uid> or shared:<workspace-id>)

# Default command
CMD ["./entrypoint.sh"]
