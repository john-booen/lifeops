export const BREEZE_RESIDENT_WORKER = String.raw`
import contextlib
import json
import queue
import sys
import threading

DIRECTION = '自然的普通话，温柔、亲切、有亲和力，像日常聊天，情绪细腻，不要夸张或播音腔。'
STREAM_INTERVAL = 0.45
MAX_INPUT = 16384
output_lock = threading.Lock()

def emit(**event):
    with output_lock:
        sys.__stdout__.write(json.dumps(event, separators=(',', ':')) + '\n')
        sys.__stdout__.flush()

def commands(inbox, requests, requests_lock):
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_INPUT + 1)
            if not line or len(line) > MAX_INPUT:
                break
            command = json.loads(line)
            cancel = command.get('cancel')
            if isinstance(cancel, str):
                with requests_lock:
                    stopped = requests.get(cancel)
                    if stopped is not None:
                        stopped.set()
                if stopped is None:
                    emit(id=cancel, done=True, cancelled=True)
                continue
            key, text = command.get('id'), command.get('text')
            if not isinstance(key, str) or not 1 <= len(key) <= 120:
                break
            if not isinstance(text, str) or not 1 <= len(text) <= 120:
                emit(id=key, error='invalid_text')
                continue
            with requests_lock:
                if key in requests:
                    continue
                stopped = threading.Event()
                requests[key] = stopped
            inbox.put((key, text, stopped))
    finally:
        with requests_lock:
            for stopped in requests.values():
                stopped.set()
        inbox.put(None)

def generate(model, breeze, text):
    return model.generate(text=text, ref_audio=breeze['referenceAudio'], ref_text=breeze['referenceText'],
                          instruct=DIRECTION, cfg_scale=4, stream=True, streaming_interval=STREAM_INTERVAL)

def main():
    import base64
    import os
    breeze = json.loads(sys.stdin.buffer.readline(MAX_INPUT + 1))['breeze']
    os.environ['HF_HOME'] = breeze['cache']
    inbox, requests, requests_lock = queue.Queue(4), {}, threading.Lock()
    threading.Thread(target=commands, args=(inbox, requests, requests_lock), daemon=True).start()
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import mlx.core as mx
        from mlx_audio.tts import load
        model = load(breeze['model'])
        warm = generate(model, breeze, '嗯。')
        try:
            first = next(warm, None)
            if first is not None and first.audio.size:
                mx.eval(first.audio)
        except Exception:
            pass
        finally:
            close = getattr(warm, 'close', None)
            if close is not None:
                close()
        emit(ready=True)
        while True:
            request = inbox.get()
            if request is None:
                break
            key, text, stopped = request
            try:
                if stopped.is_set():
                    continue
                sequence = 0
                stream = generate(model, breeze, text)
                try:
                    for result in stream:
                        if stopped.is_set():
                            break
                        if result.sample_rate != 24000:
                            raise ValueError('sample rate')
                        if not result.audio.size:
                            continue
                        mx.eval(result.audio)
                        audio = np.nan_to_num(np.asarray(result.audio, dtype=np.float32).reshape(-1), nan=0., posinf=0., neginf=0.)
                        pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
                        if len(pcm) > 4 * 1024 * 1024:
                            raise ValueError('large frame')
                        if stopped.is_set():
                            break
                        emit(id=key, seq=sequence, pcm=base64.b64encode(pcm).decode('ascii'))
                        sequence += 1
                finally:
                    close = getattr(stream, 'close', None)
                    if close is not None:
                        close()
                if not stopped.is_set():
                    if sequence:
                        emit(id=key, done=True)
                    else:
                        emit(id=key, error='empty_audio')
            except Exception:
                if not stopped.is_set():
                    emit(id=key, error='generation_failed')
            finally:
                with requests_lock:
                    requests.pop(key, None)
                if stopped.is_set():
                    emit(id=key, done=True, cancelled=True)

if __name__ == '__main__':
    main()
`;
