# Third-party notices

## unluac54.jar

Copyright (c) 2011-2025 tehtmi
With Portions Copyright (c) 2014 Thomas Klaeger

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The same license text is embedded in `tools/unluac54.jar` as `license.txt`.

## Optional vertex-fix runtime

The Windows component release includes `FivemDecryptFixer.Cli`, `FivemDecryptFixer.dll`,
`CodeWalker.Core.dll`, `SharpDX.dll`, and `SharpDX.Mathematics.dll` solely for the optional
post-decryption vertex-fix step. Only the DLL runtime and its required launcher/dependencies are
included; no server-dump or dump-tool script code is included. .NET 8 Runtime remains external.
