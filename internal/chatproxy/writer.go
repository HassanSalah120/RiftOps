package chatproxy

import (
	"context"
	"fmt"
	"io"
)

type writeRequest struct {
	data []byte
	done chan error
}

type writePump struct {
	queue chan writeRequest
}

func newWritePump(size int) *writePump {
	if size <= 0 {
		size = 64
	}
	return &writePump{queue: make(chan writeRequest, size)}
}

func (p *writePump) run(ctx context.Context, writer io.Writer) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case request := <-p.queue:
			err := writeAll(writer, request.data)
			request.done <- err
			close(request.done)
			if err != nil {
				return err
			}
		}
	}
}

func (p *writePump) write(ctx context.Context, data []byte) error {
	request := writeRequest{data: append([]byte(nil), data...), done: make(chan error, 1)}
	select {
	case p.queue <- request:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-request.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return fmt.Errorf("writer accepted zero bytes")
		}
		data = data[written:]
	}
	return nil
}
