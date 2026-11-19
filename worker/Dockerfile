# Hallraum transcription worker (WhisperX on CPU)
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# CPU build of PyTorch (small, no CUDA packages)
RUN pip install --no-cache-dir torch~=2.8.0 torchaudio~=2.8.0 torchvision~=0.23.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

ENV HF_HOME=/models PYTHONUNBUFFERED=1
VOLUME /models
COPY worker.py .
CMD ["python", "worker.py"]
