//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	th32csSnapProcess = 0x00000002
	processTerminate  = 0x0001
	errorInvalidParam = syscall.Errno(87)
)

func terminateProcessTree(pid int) error {
	parentByPID, err := snapshotProcessParents()
	if err != nil {
		return terminatePID(pid)
	}
	pids := collectProcessTreePIDs(pid, parentByPID)
	var firstErr error
	for i := len(pids) - 1; i >= 0; i-- {
		if err := terminatePID(pids[i]); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func snapshotProcessParents() (map[int]int, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(th32csSnapProcess, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(snapshot)

	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	if err := syscall.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}

	parentByPID := map[int]int{}
	for {
		parentByPID[int(entry.ProcessID)] = int(entry.ParentProcessID)
		err := syscall.Process32Next(snapshot, &entry)
		if err == syscall.ERROR_NO_MORE_FILES {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return parentByPID, nil
}

func terminatePID(pid int) error {
	handle, err := syscall.OpenProcess(processTerminate, false, uint32(pid))
	if err != nil {
		if err == syscall.ERROR_ACCESS_DENIED || err == errorInvalidParam {
			return nil
		}
		return fmt.Errorf("open process %d: %w", pid, err)
	}
	defer syscall.CloseHandle(handle)
	if err := syscall.TerminateProcess(handle, 1); err != nil {
		return fmt.Errorf("terminate process %d: %w", pid, err)
	}
	return nil
}
