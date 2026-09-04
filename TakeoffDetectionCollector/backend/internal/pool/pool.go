package pool

import "sync"

// Pool runs at most n goroutines over a work queue.
type Pool struct {
	n int
}

func New(n int) *Pool {
	if n < 1 {
		n = 1
	}
	return &Pool{n: n}
}

func (p *Pool) Do(n int, fn func(i int)) {
	if n <= 0 {
		return
	}
	jobs := make(chan int)
	var wg sync.WaitGroup
	workers := p.n
	if workers > n {
		workers = n
	}
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer wg.Done()
			for i := range jobs {
				fn(i)
			}
		}()
	}
	for i := 0; i < n; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
}
