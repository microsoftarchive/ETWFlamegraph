
var console = require('console');
var fs = require('fs');


// some constants
var newline = 10; // newline char as int
var comma = 44; // comma as int
var space = 32; // space as int

// event names for Node Javascript symbol mapping
var v8symbolLabel = 'NodeJS-ETW-provider/';
var v8symbolAdd = 'NodeJS-ETW-provider/MethodRuntime/MethodLoad';
var v8symbolReset = 'NodeJS-ETW-provider//NODE_V8SYMBOL_RESET';
var v8symbolMove = 'NodeJS-ETW-provider//NODE_V8SYMBOL_MOVE';
var v8symbolRemove = 'NodeJS-ETW-provider//NODE_V8SYMBOL_REMOVE';
var v8symbolSourceFile = "NodeJS-ETW-provider/ScriptContextRuntime/SourceLoad";

// other csv event names to process
var etlStack = 'Stack';
var etlThread = 'T-DCStart';
var etlThread2 = 'T-Start';

// module name to use for mapped javascript
var jsModule = 'JavaScript!';

// file streams
var instrm;
var outcsvstrm;


function usage() {
  console.info('Usage: node etlfold incsv [exename | pid] [-o outfold] [-s outcsv]');
  console.info('  incsv is csv file generated from xperf using stackwalk and symbols');
  console.info('  exename is the exe name with stacks to fold - default node.exe');
  console.info('  pid is the process id with stacks to fold - defaults to using node.exe');
  console.info('  outfile is optional file name with folded stack output - default <incsv>.fold');
  console.info('  outcsv is optional output csv file with resolved javascript names in stack - default none');
}


// process command line
if (process.argv.length < 3) {
  usage();
  process.exit(1);
}

// get input parameters
process.argv.shift();
process.argv.shift();

// set defaults
var infile = process.argv.shift();
var outfold = infile + '.fold';
var exename = 'node.exe';
var outcsv = null;

// check if exename or pid specified
if (process.argv.length > 0) {
  var opt = process.argv[0];
  if (opt.toLowerCase() !== '-o' && opt.toLowerCase() !== '-s') {
    exename = opt.toLowerCase();
    process.argv.shift();
  }
}
var exeIsPid = (!isNaN(exename - 0));

// get remaining optional parameters
while (process.argv.length > 0) {
  var opt = process.argv[0];
  process.argv.shift();
  if (opt.toLowerCase() === '-o' &&
      process.argv.length > 0) {
    outfold = process.argv[0];
    process.argv.shift();
  } else if (opt.toLowerCase() === '-s' &&
      process.argv.length > 0) {
    outcsv = process.argv[0];
    process.argv.shift();
  } else {
    usage();
    process.exit(1);
  }
}


// utility string functions
function trimleft(str) {
  return str.replace(/^\s+/g, '');
}

function trimboth(str) {
  return str.replace(/^\s+|\s+$/g, '');
}

function swapslash(str) {
  return str.replace(/\\/g, '/');
}


// return first field up to comma, trimmed on left
function lineType(linebuf) {
  var pos = 0;
  while (pos < linebuf.length && linebuf[pos] === space) {
    pos++;
  }
  var posEnd = pos;
  while (posEnd < linebuf.length && linebuf[posEnd] != comma) {
    posEnd++;
  }
  return linebuf.toString('ascii', pos, posEnd);
}


// find newline in buffer
function FindNewline(buf, pos) {
  var len = buf.length;
  while (pos < len && buf[pos] != newline) {
    pos++;
  }
  if (pos < len) {
    return pos;
  }
  return -1;
}


// addressMap holds address to symbol mapping info
function addressMap(symbol, start, stop, srcid, srcline) {
  this.symbol = symbol;
  this.start = start;
  this.stop = stop;
  this.srcid = srcid;
  this.srcline = srcline
}


// bucketList used to find addressMap per process
// has list of address map buckets - one per proc
function bucketList() {
  this.buckets = [];
}

// ensure bucket exists for symbol map. Create if necessary
bucketList.prototype.findOrSetBucket = function (proc, thread) {
  for (var i = 0; i < this.buckets.length; i++) {
    if (this.buckets[i].proc === proc) {
      this.buckets[i].addThread(thread);
      return this.buckets[i];
    }
  }
  var newbuck = new addressMapBucket(proc);

  newbuck.addThread(thread);
  this.buckets.push(newbuck);
  return newbuck;
}

// find bucket for stack lookup
bucketList.prototype.findThreadBucket = function (thread) {
  for (var i = 0; i < this.buckets.length; i++) {
    for (var j = 0; j < this.buckets[i].threads.length; j++) {
      if (this.buckets[i].threads[j] === thread) {
        return this.buckets[i];
      }
    }
  }
  return null;
}


// addressMapBucket tracks per process info for symbol resolving
// threads, source files, addressMaps
// constructor
function addressMapBucket(proc) {
  this.proc = proc;
  this.sorted = false;
  this.maps = [];
  this.threads = [];
  this.srcfiles = {};
}


// add a thread
addressMapBucket.prototype.addThread = function (thread) {
  for (var i = 0; i < this.threads.length; i++) {
    if (this.threads[i] === thread) return;
  }

  this.threads.push(thread);
}


// add a new source file to the bucket
addressMapBucket.prototype.addsource = function (srcid, srcname) {
  this.srcfiles[srcid] = srcname;
}


// add a new map to the bucket
addressMapBucket.prototype.addMap = function (map) {
  if (this.maps.length > 0 &&
      this.maps[this.maps.length - 1].start === map.start &&
      this.maps[this.maps.length - 1].stop === map.stop &&
      this.maps[this.maps.length - 1].symbol === map.symbol) {
    // sometimes get same values twice in a row - ignore
    return;
  }
  this.maps.push(map);
  this.sorted = false;
}


// clear the bucket
addressMapBucket.prototype.reset = function () {
  this.maps = [];
  this.srcfiles = {};
}


// update map address in bucket
addressMapBucket.prototype.move = function (map) {
  var oldmap = this.find(map.start);
  if (oldmap != null && oldmap.start === map.start) {
    // code was moved. Update existing map addresses
    var len = oldmap.stop - oldmap.start;
    oldmap.start = map.stop;
    oldmap.stop = map.stop + len;
    this.sorted = false;
  }
}


// remove map address in bucket
addressMapBucket.prototype.remove = function (map) {
  var oldmap = this.find(map.start);
  if (oldmap != null && oldmap.start === map.start) {
    // code was removed. Set existing map addresses to 0
    oldmap.start = 0;
    oldmap.stop = 0;
    this.sorted = false;
  }
}


// find  addressMap in bucket that contains addr
addressMapBucket.prototype.find = function (addr) {
  if (this.maps.length === 0)
    return null;

  // first make sure array is sorted
  if (!this.sorted) {
    this.maps.sort(function (a, b) {
      return a.start - b.start;
    });
    this.sorted = true;
  }

  // then do binary search over array
  var high = this.maps.length - 1;
  var low = 0;
  if (this.maps[high].start <= addr && this.maps[high].stop > addr) {
    return this.maps[high];
  }
  if (this.maps[low].start <= addr && this.maps[low].stop > addr) {
    return this.maps[low];
  }

  while (high - low > 1) {
    var med = low + Math.floor((high - low) / 2);
    if (this.maps[med].stop < addr) {
      low = med;
    } else if (this.maps[med].start > addr) {
      high = med;
    } else {
      return this.maps[med];
    }
  }

  return null;
}


// foldedStacks object converts stack frames to folded form and
// counts instances of same stack
// constructor
function foldedStacks() {
  this.stacks = {};
  this.threads = [];
  this.curstack = '';
}


// include thread in process
foldedStacks.prototype.addThread = function (procname, procid, thread) {
  if (exeIsPid) {
    if (procid != exename) return;
  } else {
    if (procname.toLowerCase() !== exename) return;
  }
  for (var i = 0; i < this.threads.length; i++) {
    if (this.threads[i] === thread) return;
  }
  this.threads.push(thread);
}


// complete the current stack frame - add it to collection
foldedStacks.prototype.completeCurrentStack = function () {
  // new stack. Add current stack to stacks
  if (this.curstack !== '') {
    if (this.stacks[this.curstack]) {
      // exists already. increment count
      this.stacks[this.curstack] += 1;
    } else {
      this.stacks[this.curstack] = 1;
    }
    // empty current stack
    this.curstack = '';
  }
}


// add a new stack frame if it is for matching process
foldedStacks.prototype.addStackFrame = function (thread, framenum, fullsym) {
  var match = false;
  for (var j = 0; j < this.threads.length; j++) {
    if (this.threads[j] === thread) {
      match = true;
      break;
    }
  }
  if (!match) return;

  if (framenum === '1') {
    this.completeCurrentStack();
  }

  if (fullsym.slice(0, 10) === '"Unknown"!') {
    return;
  }

  var sym = fullsym;
  var syms = fullsym.indexOf('!');
  if (syms !== -1) {
    var sym = swapslash(fullsym.slice(syms + 1));
  }

  // prepend current stack  with frame symbol and ';' delimiter
  if (this.curstack === '') {
    this.curstack = sym;
  } else {
    this.curstack = sym + ';' + this.curstack;
  }
}


// write the stacks to file after sorting
foldedStacks.prototype.writeFoldedStacks = function () {
  var lines = [];
  // convert to array of strings, and sort
  for (var propName in this.stacks) {
    var line = propName + ' ' + this.stacks[propName] + '\r\n';
    lines.push(line);
  }
  lines.sort();

  var numLines = lines.length;
  var curIndex = 0;
  var ok = 1;
  var outfoldstrm = fs.createWriteStream(outfold);

  // write until end or buffer full
  function writeLines() {
    ok = 1;
    while (ok && curIndex < numLines) {
      ok = outfoldstrm.write(lines[curIndex]);
      curIndex += 1;
    }
    if (ok) {
      outfoldstrm.end();
      outfoldstrm.destroy();
      console.info(outfold + ' written\r\n');
    }
  }

  outfoldstrm.on('open', writeLines);

  outfoldstrm.on('drain', writeLines);

  outfoldstrm.on('error', function () {
    console.log('Error writing to file: ' + outfold);
  });
}


// buffer from incsv
var line = null;
// initialize folded stacks
var foldedStack = new foldedStacks();
// initialize buckets
var buckets = new bucketList();


// process thread start line from csv
// returns same line
function processThreadStart(line) {
  var lstr = line.toString();
  var flds = lstr.split(',');

  // get process and thread
  var proc = trimleft(flds[2]);
  var thread = trimleft(flds[3]);

  // proc format is name (pid). Split out name and id
  var procname = proc.slice(0, proc.indexOf(' ('));
  var procid = trimleft(proc.slice(proc.indexOf('(') + 1, proc.indexOf(')')));

  foldedStack.addThread(procname, procid, thread);

  return line;
}


// process a source file declaration entry
// returns same line
function processV8SourceFile(line) {
  var lstr = line.toString();
  var flds = lstr.split(',', 19);

  var proc = trimleft(flds[2]);
  var thrd = trimleft(flds[3]);
  var srcid = trimleft(flds[9]);
  var srcname = trimboth(flds[12]);
  // remove quotes
  if (srcname.charAt(0) === '"' && srcname.charAt(srcname.length - 1) === '"') {
    srcname = srcname.slice(1, srcname.length - 1);
  }
  // add source file to bucket
  var bucket = buckets.findOrSetBucket(proc, thrd);
  bucket.addsource(srcid, srcname);
  return line;
}


// process javascript symbolmapping entry
// returns same line
function processAddMethodEntry(line) {
  var lstr = line.toString();
  var flds = lstr.split(',', 19);

  var proc = trimleft(flds[2]);
  var thrd = trimleft(flds[3]);
  var sym = trimboth(flds[18]);
  // remove quotes
  if (sym.charAt(0) === '"' && sym.charAt(sym.length - 1) === '"') {
    sym = sym.slice(1, sym.length - 1);
  }

  var start = parseInt(trimleft(flds[10]), 16);
  var stop = parseInt(trimleft(flds[11])) + start;
  var srcid = trimleft(flds[15]);
  var srcline = trimleft(flds[16]);

  // create map and find bucket
  var bucket = buckets.findOrSetBucket(proc, thrd);
  var map = new addressMap(sym, start, stop, srcid, srcline);

  // add to bucket
  bucket.addMap(map);

  return line;
}


//process V8 address map change
function processV8SymbolEntry(line, event) {
  var lstr = line.toString();
  var flds = lstr.split(',');
  var proc = flds[2].replace(' ', '');
  var thrd = flds[3].replace(' ', '');

  var bucket = buckets.findOrSetBucket(proc, thrd);
  if (event === v8symbolReset) {
    bucket.reset();
  } else {
    var start = parseInt(trimleft(flds[9]), 16);
    var stop = parseInt(trimleft(flds[10]), 16);
    var map = new addressMap('', start, stop, 0);

    if (event === v8symbolMove) {
      bucket.move(map);
    } else if (event === v8symbolRemove) {
      bucket.remove(map);
    }
  }
  return line;
}


// process stack line
// returns buffer with line to write
function processStackEntry(line) {
  var lstr = line.toString();
  var flds = lstr.split(',');

  var thread = trimleft(flds[2]);
  var framenum = trimleft(flds[3]);
  var fullsym = trimboth(flds[5]);

  var bucket = buckets.findThreadBucket(thread);
  if (bucket != null) {
    var addr = parseInt(trimleft(flds[4]), 16);
    var map = bucket.find(addr);

    if (map != null) {
      // found a matching symbol for this address

      // find source file if id != 0. Combine with line number
      var srcfile = '';
      if (map.srcid != 0) {
        srcfile = bucket.srcfiles[map.srcid];
        if (srcfile) {
          if (map.srcline) {
            srcfile = srcfile + ':' + map.srcline;
          }
          srcfile = ' ' + srcfile;
        } else {
          srcfile = '';
        }
      }

      // build modified symbol for javascript from symbol and source file
      fullsym = jsModule + map.symbol + srcfile;

      // modify line using mapped symbol in place of flds[5]
      var newlstr = flds[0].concat(',', flds[1], ',', flds[2], ',', flds[3], ',', flds[4], ',         ', fullsym, '\r\n');
      line = new Buffer(newlstr);
    }
  }

  // add stack entry to folded stack
  foldedStack.addStackFrame(thread, framenum, fullsym);

  // return line - modified or not
  return line;
}


// each line read is processed here
function processline(line) {
  var lineStart = lineType(line);
  var outline;
  if (lineStart === etlStack) {
    outline = processStackEntry(line);
  } else if (lineStart === etlThread) {
    outline = processThreadStart(line);
  } else if (lineStart === etlThread2) {
    outline = processThreadStart(line);
  } else if (lineStart.slice(0, v8symbolSourceFile.length) === v8symbolSourceFile) {
    outline = processV8SourceFile(line);
  } else if (lineStart.slice(0, v8symbolAdd.length) === v8symbolAdd) {
    outline = processAddMethodEntry(line);
  } else if (lineStart.slice(0, v8symbolLabel.length) === v8symbolLabel) {
    outline = processV8SymbolEntry(line, lineStart);
  } else {
    outline = line;
  }

  // if writing updated csv, write line
  if (outcsv) {
    var ok = outcsvstrm.write(outline);
    if (!ok) {
      instrm.pause();
    }
  }
}


// last line has been processed
function finished() {
  // if writing updated csv, close it
  if (outcsv) {
    outcsvstrm.end();
    outcsvstrm.destroy();
  }

  // complete last stack and write folded stacks
  foldedStack.completeCurrentStack();
  foldedStack.writeFoldedStacks();
}


// process input csv file

// open file stream
instrm = fs.createReadStream(infile);


instrm.on('open', function (fd) {
  // if writing updated csv, open it
  if (outcsv) {
    outcsvstrm = fs.createWriteStream(outcsv);

    outcsvstrm.on('drain', function () {
      instrm.resume();
    });
  }
});


instrm.on('data', function (data) {
  // break it up into lines. May need to combine data from previous data
  var pos = 0;
  var nlpos = FindNewline(data, pos);
  while (nlpos != -1) {
    nlpos++;
    if (line != null) {
      // merge with previous chunk remnant
      var merged = new Buffer(line.length + nlpos - pos);
      line.copy(merged);
      data.copy(merged, line.length, pos, nlpos);
      line = merged;
    } else {
      line = data.slice(pos, nlpos);
    }
    // process the line
    processline(line);

    // find next newline
    line = null;
    pos = nlpos;
    nlpos = FindNewline(data, pos);
  }

  // hold onto remaining data - combines with next read
  line = data.slice(pos);
});


instrm.on('end', function () {
  if (line != null) {
    // process the line
    processline(line);
  }
  finished();
});


instrm.on('error', function () {
  console.log('Error reading file: ' + infile);
});

