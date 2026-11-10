// Original fictional SC06.unclear provider response; immutable source: output/sc06-unclear-native-20261020-02/run/observation.json
// Response SHA256: 94d86946cd72b076783aa2010ff367aaf3efe5b05b8232f6ab56ba91fcd0ebe1
export const previousUnclearSnapshotResponse = "{\n  \"activeWindowTitle\": \"\",\n  \"activeProcessName\": \"\",\n  \"activity\": \"unknown\",\n  \"applicationCategory\": \"unknown\",\n  \"workContext\": \"画面显示一个模糊的界面布局，包含顶部横条、左侧垂直列表及右侧多行多列的数据网格。由于图像严重失焦，具体文字、控件功能及数据内容均无法辨认，当前用户操作未知。\",\n  \"progressIndication\": \"完成进度未知\",\n  \"needsHelp\": false,\n  \"confidence\": \"low\",\n  \"briefDescription\": \"一张极度模糊的软件界面截图，呈现典型的侧边栏加主内容区布局，右侧为密集的数据表格结构，具体内容不可读。\",\n  \"sensitive\": false\n}";

export const readableStaticSnapshot = {
  snapshotEvidenceVersion: 1, sensitive: false, confidence: "high", legibility: "partial", needsHelp: false,
  visibleText: [{ id: "t1", text: "虚构资料待核对", context: "content", position: "top", color: "black" }, { id: "t2", text: "A", context: "content", position: "center", color: "white" }],
  geometry: [{ shape: "rectangle", position: "center", color: "blue" }],
  application: { category: "unknown", textRefs: [] }, statusTextRefs: []
};

// Actual complete fictional D reply was rejected before geometry-alias compatibility.
// Source: output/sc06-typed-unclear-20261021-01/observation.json; original run remains failed.
// Response SHA256: 1ee219807fdd20f0e9da0dded2151423f018e28583a41bb129342247efe51a16
export const previousTypedUnreadableSnapshotResponse = "{\n  \"snapshotEvidenceVersion\": 1,\n  \"sensitive\": false,\n  \"confidence\": \"low\",\n  \"legibility\": \"unreadable\",\n  \"needsHelp\": false,\n  \"visibleText\": [],\n  \"geometry\": [\n    {\n      \"shape\": \"rectangle\",\n      \"position\": \"top\",\n      \"color\": \"gray\"\n    },\n    {\n      \"shape\": \"rectangle\",\n      \"position\": \"left\",\n      \"color\": \"light_gray\"\n    },\n    {\n      \"shape\": \"grid\",\n      \"position\": \"center_right\",\n      \"color\": \"white\"\n    }\n  ],\n  \"application\": {\n    \"category\": \"unknown\",\n    \"textRefs\": []\n  },\n  \"statusTextRefs\": []\n}";
