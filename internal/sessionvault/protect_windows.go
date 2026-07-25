//go:build windows

package sessionvault

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

type platformProtector struct{}

func (platformProtector) seal(plaintext, context []byte) ([]byte, error) {
	return cryptProtect(plaintext, context, true)
}

func (platformProtector) open(ciphertext, context []byte) ([]byte, error) {
	return cryptProtect(ciphertext, context, false)
}

func cryptProtect(input, entropy []byte, protect bool) ([]byte, error) {
	if len(input) == 0 {
		return nil, errors.New("empty protection input")
	}
	in := windows.DataBlob{Size: uint32(len(input)), Data: &input[0]}
	var entropyBlob windows.DataBlob
	if len(entropy) > 0 {
		entropyBlob = windows.DataBlob{Size: uint32(len(entropy)), Data: &entropy[0]}
	}
	var out windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&in, nil, &entropyBlob, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	} else {
		err = windows.CryptUnprotectData(&in, nil, &entropyBlob, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, int(out.Size))...), nil
}
