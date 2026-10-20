import Cocoa
let folder = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
for (name,size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
    let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
    let n=CGFloat(size), scale=n/1024
    NSColor(calibratedRed:0.84,green:0.87,blue:0.96,alpha:1).setFill()
    NSBezierPath(roundedRect:NSRect(x:n*0.07,y:n*0.07,width:n*0.86,height:n*0.86),xRadius:n*0.19,yRadius:n*0.19).fill()
    NSColor(calibratedRed:0.14,green:0.16,blue:0.23,alpha:1).setStroke()
    for angle in [-40.0,40.0] {
        let ellipse=NSBezierPath(ovalIn:NSRect(x:-330*scale,y:-155*scale,width:660*scale,height:310*scale));ellipse.lineWidth=43*scale
        var rotation=AffineTransform();rotation.rotate(byDegrees:CGFloat(angle));ellipse.transform(using:rotation);ellipse.transform(using:AffineTransform(translationByX:n/2,byY:n/2));ellipse.stroke()
    }
    NSColor(calibratedRed:0.14,green:0.16,blue:0.23,alpha:1).setFill()
    NSBezierPath(ovalIn:NSRect(x:n*0.445,y:n*0.445,width:n*0.11,height:n*0.11)).fill()
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:folder+"/"+name+".png"))
}
