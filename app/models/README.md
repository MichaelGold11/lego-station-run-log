# Models for the live page

- `lego-parts.onnx`: YOLO26n, 3 classes (plate, pink_brick, blue_slope), trained at 640 px. From the team's
  `vision-step-checker` branch (student ruzakansakar), file `vision/models/best.pt`.
- `hand_landmarker.task`: MediaPipe Hand Landmarker (float16), the same file the team's `vision/` folder uses.

## Output format

Input `images` [1, 3, 640, 640], RGB 0..1, letterboxed with gray 114.
Output `output0` [1, 7, 8400]: rows are cx, cy, w, h (model pixels), then one score per class. It needs NMS, which
`app/live-detect.js` does (IoU 0.7, per class). Do not export with `end2end=True`: that head ([1, 300, 6]) is not the
trained one for this checkpoint and gives different boxes than `best.pt`.

## Re-export

From the `vision/` folder of the student's branch, with its venv:

    python -c "from ultralytics import YOLO; YOLO('models/best.pt').export(format='onnx', opset=12, imgsz=640, simplify=False)"

Copy `best.onnx` here as `lego-parts.onnx`. The page reads the input size from the model, so an `imgsz=480` or
`imgsz=416` export also works if the laptop is slow.

## Wire line: one model per station

`/line` runs one model per station. Copy each station's exported `.onnx` here and add its entry under
`models` in `data/meta/wire-line.json` (see "For the model team" in `docs/wire-line-process.md`). The page
checks the file's class count against the config's class list and falls back to zones for a station that
does not match.
