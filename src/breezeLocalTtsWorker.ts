// Offline worker embedded in the plugin; configuration and text travel over stdin.
export const BREEZE_LOCAL_WORKER_SOURCE = String.raw`
"""Single-turn offline Breeze worker; stdout contains framed PCM16 only."""
import contextlib
import json
import os
import struct
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
DIRECTION = '自然的普通话，温柔、亲切、有亲和力，像日常聊天，情绪细腻，不要夸张或播音腔。'

def main():
    request = json.loads(sys.stdin.buffer.readline(16385))
    text = request['text']
    if not isinstance(text, str) or not 1 <= len(text) <= 120:
        raise ValueError('invalid text')
    breeze = request['breeze']
    os.environ['HF_HOME'] = breeze['cache']
    binary_output = sys.stdout.buffer
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import mlx.core as mx
        from mlx_audio.tts import load
        model = load(breeze['model'])
        stream = model.generate(text=text, ref_audio=breeze['referenceAudio'], ref_text=breeze['referenceText'],
                                instruct=DIRECTION, cfg_scale=4, stream=True,
                                streaming_interval=1.0)
        for result in stream:
            if result.sample_rate != 24000:
                raise ValueError('unexpected sample rate')
            if result.audio.size:
                mx.eval(result.audio)
                x = np.nan_to_num(np.asarray(result.audio, dtype=np.float32).reshape(-1), nan=0., posinf=0., neginf=0.)
                pcm = (np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()
                if len(pcm) > 4 * 1024 * 1024:
                    raise ValueError('audio frame too large')
                binary_output.write(struct.pack('>I', len(pcm)))
                binary_output.write(pcm)
                binary_output.flush()

if __name__ == '__main__':
    main()
`;
