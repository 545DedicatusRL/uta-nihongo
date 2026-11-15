// 生成程序图标（public/icon.png）。用法：osascript -l JavaScript tools/make-icon.jxa.js <输出路径>
ObjC.import('AppKit');
function run(argv) {
  const out = argv[0];
  const size = 512;
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(size, size));
  img.lockFocus;
  const rgb = (r, g, b, a) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, a === undefined ? 1 : a);
  // 圆角底板 + 渐变（和界面里的粉 / 靛蓝一致）
  const plate = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(36, 36, 440, 440), 104, 104);
  $.NSGradient.alloc.initWithStartingColorEndingColor(rgb(255, 138, 164), rgb(86, 78, 190)).drawInBezierPathAngle(plate, -55);
  // 主字「あ」
  const attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey($.NSFont.fontWithNameSize('HiraginoSans-W7', 268) || $.NSFont.boldSystemFontOfSize(268), $.NSFontAttributeName);
  attrs.setObjectForKey($.NSColor.whiteColor, $.NSForegroundColorAttributeName);
  const s = $('あ');
  const sz = s.sizeWithAttributes(attrs);
  s.drawAtPointWithAttributes($.NSMakePoint((size - sz.width) / 2 - 14, (size - sz.height) / 2 - 6), attrs);
  // 右上角的音符
  const na = $.NSMutableDictionary.alloc.init;
  na.setObjectForKey($.NSFont.boldSystemFontOfSize(120), $.NSFontAttributeName);
  na.setObjectForKey(rgb(255, 255, 255, 0.92), $.NSForegroundColorAttributeName);
  $('♪').drawAtPointWithAttributes($.NSMakePoint(352, 316), na);
  img.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  return png.writeToFileAtomically(out, true) ? 'ok' : 'failed';
}
