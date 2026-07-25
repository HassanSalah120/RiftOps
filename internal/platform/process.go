package platform

import "os/exec"

type commandProcess struct{ command *exec.Cmd }

func (p *commandProcess) PID() int {
	if p.command.Process == nil {
		return 0
	}
	return p.command.Process.Pid
}
func (p *commandProcess) Wait() error { return p.command.Wait() }
func (p *commandProcess) Kill() error {
	if p.command.Process == nil {
		return nil
	}
	return p.command.Process.Kill()
}
