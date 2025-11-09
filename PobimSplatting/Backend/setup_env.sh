#!/bin/bash

# Setup Python virtual environment for Backend
echo "Setting up Python virtual environment for Backend..."

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install requirements
pip install -r requirements.txt

echo "Backend environment setup complete!"
echo "To activate the environment, run: source venv/bin/activate"