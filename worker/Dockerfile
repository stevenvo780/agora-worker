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
    file \
    man-db \
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
    rename \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Locales for proper encoding
    locales \
    # Terminal enhancements
    bash-completion \
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

ARG ST_LANG_VERSION=3.2.2
ENV ST_LANG_VERSION=${ST_LANG_VERSION}

# Install eza (modern ls replacement with colors + icons)
RUN mkdir -p /etc/apt/keyrings && \
    wget -qO- https://raw.githubusercontent.com/eza-community/eza/main/deb.asc | gpg --dearmor -o /etc/apt/keyrings/gierens.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/gierens.gpg] http://deb.gierens.de stable main" | tee /etc/apt/sources.list.d/gierens.list && \
    apt-get update && apt-get install -y eza && \
    rm -rf /var/lib/apt/lists/* || true

# Install global npm packages
RUN npm install -g \
    pnpm \
    yarn \
    typescript \
    ts-node \
    nodemon \
    live-server \
    http-server \
    @stevenvo780/st-lang@${ST_LANG_VERSION} \
    @openai/codex \
    @anthropic-ai/claude-code \
    @google/gemini-cli

# Create symlinks for better command names
RUN ln -sf /usr/bin/fdfind /usr/bin/fd && \
    ln -sf /usr/bin/batcat /usr/bin/bat 2>/dev/null || true && \
    ln -sf /usr/bin/python3 /usr/bin/python 2>/dev/null || true

# Create estudiante user with sudo privileges (passwordless)
RUN useradd -m -s /bin/bash estudiante && \
    echo "estudiante ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    usermod -aG sudo estudiante

# ── Enhanced shell configuration ──────────────────────────────────
# Copy shell config and append to global bashrc
COPY shell-config/bashrc-extra.sh /tmp/bashrc-extra.sh
RUN cat /tmp/bashrc-extra.sh >> /etc/bash.bashrc && rm /tmp/bashrc-extra.sh

# Ensure the estudiante user's .bashrc sources the global config
RUN echo '' >> /home/estudiante/.bashrc && \
    echo '# Source global bashrc for enhanced shell' >> /home/estudiante/.bashrc && \
    echo 'if [ -f /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi' >> /home/estudiante/.bashrc

# Configure git defaults
RUN git config --system color.ui auto && \
    git config --system init.defaultBranch main && \
    git config --system core.autocrlf input

# Backup skeleton home files so entrypoint can restore them when /home/estudiante
# is mounted as an empty persistent volume (preserving .codex, .claude, etc.)
RUN cp -a /home/estudiante /etc/skel-estudiante

# Create /workspace with proper permissions
RUN mkdir -p /workspace && chown estudiante:estudiante /workspace

WORKDIR /app

# Install Node requirements
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY index.js .
COPY sync_agent.js .
COPY entrypoint.sh .

# Clean up any stale serviceAccountKey.json directory from cache
RUN rm -rf /app/serviceAccountKey.json 2>/dev/null || true

# Make entrypoint executable
RUN chmod +x entrypoint.sh

# Environment defaults
ENV NEXUS_URL=http://localhost:3010
# WORKER_TOKEN must be provided at runtime (e.g., personal:<uid> or shared:<workspace-id>)

# Run as non-root to keep workspace file ownership aligned with host user
USER estudiante

# Default command
CMD ["./entrypoint.sh"]
